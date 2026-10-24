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
 * Name a slot. Uses a Solidity storage layout if we have one (simulation mode), resolving
 * `mapping(address => ...)` entries for a set of known keys (the simulated users).
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
  for (const e of layout) {
    if (!e.type.startsWith("t_mapping(t_address")) continue;
    for (const k of mappingKeys) {
      const derived = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [k as Hex, BigInt(e.slot)]));
      if (normalizeWord(derived) === s) return `${e.label}[${k.slice(0, 8)}…]`;
    }
  }
  return shortSlot(s);
}

export function shortSlot(slot: string): string {
  const v = BigInt(slot);
  // Small numbers are plain sequential slots (slot 0, 1, 2...). Large ones are hashed: mapping or ERC-7201.
  return v < 1n << 32n ? `slot ${v}` : `slot ${slot.slice(0, 10)}…${slot.slice(-4)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
