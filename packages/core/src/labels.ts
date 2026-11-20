import { decodeAbiParameters, hexToString, keccak256, encodeAbiParameters, type Hex } from "viem";
import type { Rpc } from "./rpc.ts";
import { normalizeWord } from "./keys.ts";

const KNOWN: Record<string, string> = {
  "0x0000000000000000000000000000000000001000": "Monad staking precompile",
};

const WELL_KNOWN_SLOTS: Record<string, string> = {
  [normalizeWord("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")]: "EIP-1967 implementation",
  [normalizeWord("0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103")]: "EIP-1967 admin",
};

export interface ContractLabel {
  address: string;
  name: string | null;
  symbol: string | null;
  isProxy: boolean;
}

/** Best-effort human name for a contract: known list, then ERC-20 name()/symbol(). */
export async function labelContract(rpc: Rpc, address: string): Promise<ContractLabel> {
  const a = address.toLowerCase();
  if (KNOWN[a]) return { address: a, name: KNOWN[a], symbol: null, isProxy: false };
  const [name, symbol, impl] = await Promise.all([
    callString(rpc, a, "0x06fdde03"),
    callString(rpc, a, "0x95d89b41"),
    rpc
      .call<string>("eth_getStorageAt", [a, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"])
      .catch(() => "0x0"),
  ]);
  return { address: a, name, symbol, isProxy: BigInt(impl) !== 0n };
}

async function callString(rpc: Rpc, to: string, data: string): Promise<string | null> {
  try {
    const out = await rpc.call<Hex>("eth_call", [{ to, data }, "latest"]);
    if (out.length < 2 + 64 * 2) return out.length === 66 ? trimBytes32(out) : null;
    return decodeAbiParameters([{ type: "string" }], out)[0] || null;
  } catch {
    return null;
  }
}

function trimBytes32(word: Hex): string | null {
  const s = hexToString(word, { size: 32 }).replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(s) ? s : null;
}

/** Solidity storage layout entry as emitted by `forge inspect <C> storageLayout`. */
export interface LayoutEntry {
  label: string;
  slot: string;
  offset: number;
  type: string;
}

/**
 * Name a slot. Uses a Solidity storage layout if we have one (simulation mode), resolving mapping
 * entries for a set of known keys (the simulated users and the scenario's call arguments).
 */
export function labelSlot(slot: string, layout?: LayoutEntry[], mappingKeys: string[] = []): string {
  const s = normalizeWord(slot);
  if (WELL_KNOWN_SLOTS[s]) return WELL_KNOWN_SLOTS[s];
  if (!layout) return shortSlot(s);
  const v = BigInt(s);
  const direct = layout.filter((e) => BigInt(e.slot) === v);
  if (direct.length) return direct.map((e) => e.label).join(" / ");
  // Fixed-size arrays of full words occupy consecutive slots: T[n] at base..base+n-1.
  for (const e of layout) {
    const m = /^t_array\(t_u?int256\)(\d+)_storage$/.exec(e.type);
    if (m && v > BigInt(e.slot) && v < BigInt(e.slot) + BigInt(m[1])) return `${e.label}[${v - BigInt(e.slot)}]`;
  }
  // Mappings, one or two levels deep (mapping(K1 => V) and mapping(K1 => mapping(K2 => V))), tried with
  // every candidate key whose shape fits the key type.
  for (const e of layout) {
    const keyTypes = mappingKeyTypes(e.type);
    if (!keyTypes.length) continue;
    const base = BigInt(e.slot);
    for (const k1 of mappingKeys) {
      const s1 = mappingSlot(keyTypes[0], k1, base);
      if (s1 === null) continue;
      if (normalizeWord(s1) === s) return `${e.label}[${showKey(k1)}]`;
      if (keyTypes.length < 2) continue;
      for (const k2 of mappingKeys) {
        const s2 = mappingSlot(keyTypes[1], k2, BigInt(s1));
        if (s2 !== null && normalizeWord(s2) === s) return `${e.label}[${showKey(k1)}][${showKey(k2)}]`;
      }
    }
  }
  return shortSlot(s);
}

/** Key types of a (possibly nested) mapping type id, e.g. t_mapping(t_uint64,t_mapping(t_address,t_uint256)). */
function mappingKeyTypes(type: string): string[] {
  const out: string[] = [];
  let t = type;
  while (t.startsWith("t_mapping(") && out.length < 2) {
    const inner = t.slice("t_mapping(".length, -1);
    const comma = inner.indexOf(",");
    out.push(inner.slice(0, comma));
    t = inner.slice(comma + 1);
  }
  return out;
}

/** keccak256(key . slot) for a value-type key, or null when the candidate does not fit the key type. */
function mappingSlot(keyType: string, key: string, slot: bigint): Hex | null {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(key);
  if (keyType === "t_address" || keyType.startsWith("t_contract")) {
    return isAddress ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key as Hex, slot])) : null;
  }
  if (/^t_u?int\d+$/.test(keyType) || keyType === "t_bytes32") {
    if (isAddress) return null;
    let v: bigint;
    try {
      v = BigInt(key);
    } catch {
      return null;
    }
    if (v < 0n || v >= 1n << 256n) return null;
    return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [v, slot]));
  }
  return null;
}

function showKey(k: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(k) ? `${k.slice(0, 8)}…` : k;
}

export function shortSlot(slot: string): string {
  const v = BigInt(slot);
  // Small numbers are plain sequential slots (slot 0, 1, 2...). Large ones are hashed: mapping or ERC-7201.
  return v < 1n << 32n ? `slot ${v}` : `slot ${slot.slice(0, 10)}…${slot.slice(-4)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Name a MIP-8 page: which declared variables live on it (simulation mode), else its slot range. */
export function labelPage(pageHex: string, layout?: LayoutEntry[]): string {
  const page = BigInt(pageHex);
  const first = page << 7n;
  const last = first + 127n;
  const range = page < 1n << 24n ? `slots ${first}–${last}` : `hashed slots`;
  if (!layout) return `page ${page < 1n << 24n ? page : pageHex.slice(0, 10) + "…"} (${range})`;
  const vars = layout.filter((e) => BigInt(e.slot) >= first && BigInt(e.slot) <= last).map((e) => e.label);
  return `page ${page} (${vars.length ? vars.join(", ") : range})`;
}
