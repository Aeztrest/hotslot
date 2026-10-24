import type { RawTx, StateMap } from "./access.ts";
import { accountKey, normalizeWord, storageKey, type StateKey } from "./keys.ts";
import type { Rpc } from "./rpc.ts";

/**
 * How a transaction uses the value of a shared slot. Found by perturbation: replay the transaction on
 * the real pre-block state, then replay it again with only that slot changed, and diff the effects.
 *
 *   unused       read, but changing it changes nothing                       -> avoidable
 *   overwrite    the old value is ignored; the tx writes the same new value   -> avoidable
 *   accumulator  the tx adds a fixed delta (x += d); nothing else depends on x -> avoidable
 *   guard        the value only decides whether the tx succeeds or reverts    -> usually inherent
 *   dependent    other writes, transfers or calls are computed from the value -> inherent
 */
export type Usage = "unused" | "overwrite" | "accumulator" | "guard" | "dependent";

export const USAGE_RANK: Record<Usage, number> = { unused: 0, overwrite: 1, accumulator: 2, guard: 3, dependent: 4 };

export const AVOIDABLE: ReadonlySet<Usage> = new Set(["unused", "overwrite", "accumulator"]);

export interface ProbeResult {
  hash: string;
  usage: Usage | null;
  /** Why the probe could not classify, when usage is null. */
  skipped?: string;
  /** Other state that changed when only this slot changed. Evidence for "dependent". */
  affectedKeys?: StateKey[];
  /** The value also shows up in emitted logs or the return data. Harmless for state, worth noting. */
  observable?: boolean;
}

interface Replay {
  reverted: boolean;
  touched: StateMap;
  writes: Map<StateKey, bigint>;
  logs: string;
  output: string;
}

interface CallFrame {
  error?: string;
  output?: string;
  logs?: { address: string; topics: string[]; data: string }[];
  calls?: CallFrame[];
}

const WORD = 1n << 256n;
const PERTURBATIONS = [1n, 0x1234567n];

export async function probeSlot(
  rpc: Rpc,
  tx: RawTx,
  /** Block the tx was included in, and its position in it. */
  blockNumber: number,
  txIndex: number,
  address: string,
  slot: string,
  feeRecipient: string,
): Promise<ProbeResult> {
  if (!tx.to) return { hash: tx.hash, usage: null, skipped: "contract creation" };
  if (BigInt(tx.gas) === 0n) return { hash: tx.hash, usage: null, skipped: "system transaction" };

  const target = storageKey(address, slot);
  const ignore = new Set([accountKey(tx.from, "balance"), accountKey(tx.from, "nonce"), accountKey(feeRecipient, "balance")]);

  let v0: bigint;
  let base: Replay;
  let prior: Overrides;
  let ctx: ReplayContext;
  try {
    const receipt = await rpc.call<{ status: string }>("eth_getTransactionReceipt", [tx.hash]);
    if (receipt.status !== "0x1") return { hash: tx.hash, usage: null, skipped: "reverted on-chain" };
    ctx = {
      tag: "0x" + blockNumber.toString(16),
      call: {
        from: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
        gas: tx.gas,
        ...(tx.maxFeePerGas ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice }),
      },
    };
    prior = await stateBeforeTx(rpc, blockNumber, txIndex);
    base = await replay(rpc, ctx, prior);
    if (base.reverted) {
      // Replays can meter gas slightly differently from the block executor. Retry with headroom;
      // only code that branches on gasleft() could notice.
      ctx.call = { ...ctx.call, gas: "0x" + (BigInt(tx.gas) * 4n).toString(16) };
      base = await replay(rpc, ctx, prior);
      if (base.reverted) return { hash: tx.hash, usage: null, skipped: "reverts when replayed" };
    }
    // Fidelity check: the unmodified replay must write exactly what the chain recorded for this tx.
    const mined = await minedStorageWrites(rpc, blockNumber, txIndex);
    const mismatch = differingKeys(mined, storageOnly(base.writes), () => false);
    if (mismatch.length > 0) return { hash: tx.hash, usage: null, skipped: `replay diverged from chain on ${mismatch.length} slot(s)` };
    const pre = findSlot(base.touched, address, slot);
    if (pre === undefined) return { hash: tx.hash, usage: null, skipped: "replay does not touch the slot" };
    v0 = pre;
  } catch (err) {
    return { hash: tx.hash, usage: null, skipped: `replay failed: ${(err as Error).message}` };
  }

  let worst: Usage = "unused";
  let affected: StateKey[] = [];
  let observable = false;
  for (const delta of PERTURBATIONS) {
    const v1 = v0 + delta < WORD ? v0 + delta : v0 - delta;
    const override = withSlot(prior, address, slot, v1);
    let p: Replay;
    try {
      p = await replay(rpc, ctx, override);
    } catch (err) {
      return { hash: tx.hash, usage: null, skipped: `perturbed replay failed: ${(err as Error).message}` };
    }
    const verdict = classifyPerturbation(base, p, target, v0, v1, ignore);
    const usage = verdict.usage;
    if (verdict.affected.length) affected = verdict.affected;
    if (p.logs !== base.logs || p.output !== base.output) observable = true;
    if (USAGE_RANK[usage] > USAGE_RANK[worst]) worst = usage;
  }
  return { hash: tx.hash, usage: worst, affectedKeys: affected.length ? affected : undefined, observable };
}

/** The effects of one replay that the classification compares. */
export interface ReplayEffects {
  reverted: boolean;
  writes: Map<StateKey, bigint>;
}

/**
 * Decide how a tx uses `target` from two replays: `base` with the slot at its real value `v0`, and
 * `perturbed` with only that slot changed to `v1`. Keys in `ignore` (gas payment) are not compared.
 */
export function classifyPerturbation(
  base: ReplayEffects,
  perturbed: ReplayEffects,
  target: StateKey,
  v0: bigint,
  v1: bigint,
  ignore: ReadonlySet<StateKey> = new Set(),
): { usage: Usage; affected: StateKey[] } {
  if (perturbed.reverted) return { usage: "guard", affected: [] };
  const affected = differingKeys(base.writes, perturbed.writes, (k) => k === target || ignore.has(k));
  if (affected.length > 0) return { usage: "dependent", affected };
  const w0 = base.writes.get(target) ?? v0;
  const w1 = perturbed.writes.get(target) ?? v1;
  if (w0 === v0 && w1 === v1) return { usage: "unused", affected };
  if (w0 === w1) return { usage: "overwrite", affected };
  if (mod(w1 - v1) === mod(w0 - v0)) return { usage: "accumulator", affected };
  // The new value depends on the old one in a non-additive way, e.g. x = max(x, y) or x = x * k.
  return { usage: "dependent", affected };
}

type Overrides = Record<string, { stateDiff?: Record<string, string>; balance?: string; nonce?: string; code?: string }>;

const blockDiffCache = new Map<number, Promise<{ result: { pre: StateMap; post: StateMap } }[]>>();

/**
 * Overrides that reproduce the exact state tx `txIndex` saw.
 *
 * eth_call/debug_traceCall only run on block boundaries, and Monad's RPC ignores blockOverrides, so the
 * call context (block.number, timestamp) is that of whichever block we run on. We therefore run on
 * block B itself - correct context - and rewind every key that tx `txIndex` or any later tx in B
 * wrote back to its value before the first of those writes (taken from the diffMode trace).
 */
async function stateBeforeTx(rpc: Rpc, blockNumber: number, txIndex: number): Promise<Overrides> {
  if (!blockDiffCache.has(blockNumber)) {
    blockDiffCache.set(
      blockNumber,
      rpc.call("debug_traceBlockByNumber", ["0x" + blockNumber.toString(16), { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]),
    );
  }
  const traces = await blockDiffCache.get(blockNumber)!;
  const out: Overrides = {};
  // Walk backwards so the earliest write's pre-value is the one that sticks.
  for (let i = traces.length - 1; i >= txIndex; i--) {
    const { pre, post } = traces[i].result;
    for (const addr of new Set([...Object.keys(pre), ...Object.keys(post)])) {
      const a = addr.toLowerCase();
      const before = pre[addr];
      const after = post[addr] ?? {};
      const o = (out[a] ??= {});
      if (!before) {
        // Account did not exist before this tx.
        o.balance = "0x0";
        o.nonce = "0x0";
        o.code = "0x";
      } else {
        if (after.balance !== undefined || before.balance !== undefined) o.balance = before.balance ?? "0x0";
        if (after.nonce !== undefined || before.nonce !== undefined) o.nonce = "0x" + (before.nonce ?? 0).toString(16);
        if (after.code !== undefined) o.code = before.code ?? "0x";
      }
      // diffMode omits slots that were zero before the tx, so a slot only in `post` was zero.
      for (const k of new Set([...Object.keys(before?.storage ?? {}), ...Object.keys(after.storage ?? {})])) {
        (o.stateDiff ??= {})[normalizeWord(k)] = normalizeWord(before?.storage?.[k] ?? "0x0");
      }
    }
  }
  return out;
}

async function minedStorageWrites(rpc: Rpc, blockNumber: number, txIndex: number): Promise<Map<StateKey, bigint>> {
  await stateBeforeTx(rpc, blockNumber, txIndex); // populates the cache
  const { post } = (await blockDiffCache.get(blockNumber)!)[txIndex].result;
  const out = new Map<StateKey, bigint>();
  for (const [addr, acc] of Object.entries(post)) for (const [k, v] of Object.entries(acc.storage ?? {})) out.set(storageKey(addr, k), BigInt(v));
  return out;
}

function storageOnly(m: Map<StateKey, bigint>): Map<StateKey, bigint> {
  return new Map([...m].filter(([k]) => k.includes(":0x")));
}

function withSlot(base: Overrides, address: string, slot: string, value: bigint): Overrides {
  const a = address.toLowerCase();
  const o = { ...base[a] };
  o.stateDiff = { ...o.stateDiff, [normalizeWord(slot)]: normalizeWord("0x" + value.toString(16)) };
  return { ...base, [a]: o };
}

interface ReplayContext {
  /** Block whose context (number, timestamp) the replay runs in: the including block. */
  tag: string;
  call: Record<string, string | undefined>;
}

async function replay(rpc: Rpc, ctx: ReplayContext, stateOverrides: Overrides): Promise<Replay> {
  const opts = (tracer: string, tracerConfig: object) => ({ tracer, tracerConfig, stateOverrides });
  const [touched, diff, frame] = await Promise.all([
    rpc.call<StateMap>("debug_traceCall", [ctx.call, ctx.tag, opts("prestateTracer", {})]),
    rpc.call<{ pre: StateMap; post: StateMap }>("debug_traceCall", [ctx.call, ctx.tag, opts("prestateTracer", { diffMode: true })]),
    rpc.call<CallFrame>("debug_traceCall", [ctx.call, ctx.tag, opts("callTracer", { withLog: true })]),
  ]);
  const writes = new Map<StateKey, bigint>();
  for (const [addr, post] of Object.entries(diff.post)) {
    for (const [s, v] of Object.entries(post.storage ?? {})) writes.set(storageKey(addr, s), BigInt(v));
    if (post.balance !== undefined) writes.set(accountKey(addr, "balance"), BigInt(post.balance));
  }
  return { reverted: frame.error !== undefined, touched, writes, logs: JSON.stringify(collectLogs(frame)), output: frame.output ?? "" };
}

function collectLogs(f: CallFrame, out: unknown[] = []): unknown[] {
  for (const l of f.logs ?? []) out.push([l.address.toLowerCase(), l.topics, l.data]);
  for (const c of f.calls ?? []) collectLogs(c, out);
  return out;
}

function differingKeys(a: Map<StateKey, bigint>, b: Map<StateKey, bigint>, skip: (k: StateKey) => boolean): StateKey[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => !skip(k) && a.get(k) !== b.get(k)).sort();
}

function findSlot(state: StateMap, address: string, slot: string): bigint | undefined {
  const want = normalizeWord(slot);
  for (const [addr, acc] of Object.entries(state)) {
    if (addr.toLowerCase() !== address) continue;
    for (const [s, v] of Object.entries(acc.storage ?? {})) if (normalizeWord(s) === want) return BigInt(v);
  }
  return undefined;
}

function mod(x: bigint): bigint {
  return ((x % WORD) + WORD) % WORD;
}

/** Combine per-transaction probes into one verdict per slot: the most restrictive usage observed wins. */
export function combineProbes(results: ProbeResult[]): { usage: Usage | null; counts: Partial<Record<Usage, number>>; probed: number } {
  const counts: Partial<Record<Usage, number>> = {};
  let usage: Usage | null = null;
  for (const r of results) {
    if (!r.usage) continue;
    counts[r.usage] = (counts[r.usage] ?? 0) + 1;
    if (usage === null || USAGE_RANK[r.usage] > USAGE_RANK[usage]) usage = r.usage;
  }
  return { usage, counts, probed: results.filter((r) => r.usage).length };
}
