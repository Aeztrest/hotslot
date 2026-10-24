import type { TxAccess } from "./access.ts";
import { aggregate, type Summary } from "./aggregate.ts";
import type { BlockAnalysis } from "./graph.ts";
import { isStorageKey, parseKey, type StateKey } from "./keys.ts";

/**
 * MIP-8 (Page-ified Storage State) groups storage into pages of 128 consecutive slots:
 * page_index(slot) = slot >> 7. Pages are the unit of disk I/O, of the state commitment, and of
 * SLOAD/SSTORE gas (the first touch of a page is cold, later slots on it are warm).
 *
 * MIP-8 does not say whether parallel execution detects conflicts per slot or per page. If it is per
 * page, two transactions writing *different* slots on the same page still conflict: false sharing,
 * exactly like two CPU cores writing different variables on one cache line. These helpers rerun the
 * analysis at page granularity so both cases can be reported side by side.
 */
export const SLOTS_PER_PAGE_LOG2 = 7n;

export function pageIndex(slot: string): bigint {
  return BigInt(slot) >> SLOTS_PER_PAGE_LOG2;
}

export function pageKeyOf(storageKey: StateKey): StateKey {
  const { address, slot } = parseKey(storageKey);
  return `${address}:page:0x${pageIndex(slot).toString(16)}`;
}

/** The same transaction, with every storage slot replaced by the page that holds it. */
export function toPageAccess(tx: TxAccess): TxAccess {
  const map = (keys: Set<StateKey>) => new Set([...keys].map((k) => (isStorageKey(k) ? pageKeyOf(k) : k)));
  return { ...tx, reads: map(tx.reads), writes: map(tx.writes) };
}

export interface FalseSharingPage {
  key: StateKey;
  address: string;
  page: string;
  /** Waits that exist only because of this page: the two txs touched different slots on it. */
  waits: number;
  blocks: number;
  samples: { block: number; from: string; to: string }[];
}

export interface PageComparison {
  /** Same metrics as the slot-level summary, computed with page-level conflicts. */
  summary: Summary;
  blocks: { number: number; pathLength: number; storagePathLength: number }[];
  /** Waits (edges) at page level, and how many of them do not exist at slot level. */
  pageEdges: number;
  falseSharingEdges: number;
  falseSharing: FalseSharingPage[];
}

/**
 * Compare a range analyzed per slot with the same range analyzed per page. An edge that exists at page
 * level but not at slot level is false sharing; its page keys are the ones responsible.
 */
export function comparePages(slotBlocks: BlockAnalysis[], pageBlocks: BlockAnalysis[]): PageComparison {
  const bySlot = new Map(slotBlocks.map((b) => [b.number, b]));
  const pages = new Map<StateKey, FalseSharingPage>();
  let pageEdges = 0;
  let falseSharingEdges = 0;

  for (const pb of pageBlocks) {
    const sb = bySlot.get(pb.number);
    if (!sb) continue;
    const slotPairs = new Set(sb.edges.map((e) => `${e.from}-${e.to}`));
    const seenHere = new Set<StateKey>();
    for (const e of pb.edges) {
      pageEdges += 1;
      if (slotPairs.has(`${e.from}-${e.to}`)) continue;
      falseSharingEdges += 1;
      for (const k of e.keys) {
        if (!isStorageKey(k)) continue;
        let p = pages.get(k);
        if (!p) {
          const { address, slot } = parseKey(k);
          p = { key: k, address, page: slot.slice("page:".length), waits: 0, blocks: 0, samples: [] };
          pages.set(k, p);
        }
        p.waits += 1;
        if (!seenHere.has(k)) {
          p.blocks += 1;
          seenHere.add(k);
        }
        if (p.samples.length < 3) p.samples.push({ block: pb.number, from: pb.txs[e.from].hash, to: pb.txs[e.to].hash });
      }
    }
  }

  return {
    summary: aggregate(pageBlocks).summary,
    blocks: pageBlocks.map((b) => ({ number: b.number, pathLength: b.pathLength, storagePathLength: b.storagePathLength })),
    pageEdges,
    falseSharingEdges,
    falseSharing: [...pages.values()].sort((a, b) => b.waits - a.waits).slice(0, 30),
  };
}
