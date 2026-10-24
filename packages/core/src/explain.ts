import type { Usage } from "./probe.ts";

/** Plain-language explanation and fix for each usage class. Shared by the CLI and the dashboard. */
export const USAGE_INFO: Record<Usage, { title: string; avoidable: boolean; why: string; fix: string }> = {
  unused: {
    title: "Read but irrelevant",
    avoidable: true,
    why: "The transaction reads this slot, but its value has no effect on the outcome. The read alone makes it wait for whoever wrote the slot last.",
    fix: "Remove the read from the hot path, or move it to a view function.",
  },
  overwrite: {
    title: "Last-writer slot",
    avoidable: true,
    why: "Every transaction overwrites the slot (e.g. lastCaller, lastUpdatedAt) and never uses the old value. The conflict exists only because they all write to one place.",
    fix: "Emit an event instead, or store it per user (mapping keyed by msg.sender).",
  },
  accumulator: {
    title: "Shared counter",
    avoidable: true,
    why: "Every transaction does x += delta and nothing else depends on x. The additions commute, but because they all hit one slot, each one waits for the previous.",
    fix: "Shard the counter (mapping by msg.sender or by shard id, summed in a view), or drop it and aggregate from events off-chain.",
  },
  guard: {
    title: "Guard",
    avoidable: false,
    why: "The value decides whether the transaction succeeds (supply cap, threshold, pause flag that is being written). The order genuinely matters near the limit.",
    fix: "Usually inherent. If the guard is far from its limit, a per-user allowance or epoch-based cap can remove the shared read.",
  },
  dependent: {
    title: "Data dependency",
    avoidable: false,
    why: "The transaction computes other state from this value (price from reserves, shares from totalAssets). Running it on a stale value would give a different result.",
    fix: "Inherent to the logic. It can only be reduced by batching: collect requests and settle them per block or epoch.",
  },
};
