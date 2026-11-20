import type { ContractHotspot, Hotspot, Summary } from "./aggregate.ts";
import type { BlockAnalysis } from "./graph.ts";
import type { ContractLabel } from "./labels.ts";
import type { ProbeResult, Usage } from "./probe.ts";
import type { FalseSharingPage, PageComparison } from "./pages.ts";

/** Everything the dashboard renders. Written by `hotslot scan` and `hotslot simulate`. */
export interface Report {
  kind: "network" | "simulation";
  title: string;
  generatedAt: string;
  rpc: string;
  chainId: number;
  summary: Summary;
  /** One row per block, for charts. */
  blocks: {
    number: number;
    txCount: number;
    pathLength: number;
    storagePathLength: number;
    balancePathLength: number;
    noncePathLength: number;
    conflictedTxs: number;
    /** Estimated gas: all txs, the most expensive chain, its storage-only version, and the heaviest single tx. */
    totalCost: number;
    pathCost: number;
    storagePathCost: number;
    maxTxCost: number;
  }[];
  hotspots: ReportHotspot[];
  contracts: (ContractHotspot & { label: ContractLabel | null })[];
  /** A few blocks with their full dependency graph, for the graph view. */
  showcase: BlockAnalysis[];
  /**
   * The same blocks analyzed with MIP-8 page granularity (conflicts per 128-slot page instead of per
   * slot). MIP-8 does not specify which one parallel execution uses, so both are reported.
   */
  pages?: Omit<PageComparison, "falseSharing"> & { falseSharing: (FalseSharingPage & { label: ContractLabel | null; pageLabel: string })[] };
  /** `scan --contract`: how one contract fares, from the point of view of its own users. */
  focus?: FocusReport;
  /** Simulation only: what was run. */
  scenario?: { contract: string; users: number; action: string; description: string };
}

export interface FocusReport {
  address: string;
  label: ContractLabel | null;
  /** Txs that used the contract (called it directly or through another contract), and how many waited. */
  txsTo: number;
  waitedTo: number;
  /** What those waiting txs waited on, by account (a tx can wait on several). "sender" = nonce order. */
  blockedBy: { address: string; label: ContractLabel | null; waits: number }[];
  /** Waits anywhere in the range caused by this contract's own slots or MON balance. */
  waitsOnItsState: number;
  /** Network parallelism if this contract alone were fixed, everything else kept. */
  parallelismIfFixed: number;
  costParallelismIfFixed: number;
  /** When the contract is hot together with another, fixing the pair: the partner that gains most. */
  withPartner: { address: string; label: ContractLabel | null; parallelism: number; costParallelism: number } | null;
}

export interface ReportHotspot extends Hotspot {
  label: ContractLabel | null;
  slotLabel: string;
  probe?: { usage: Usage | null; counts: Partial<Record<Usage, number>>; probed: number; results: ProbeResult[] };
}

export type { ContractLabel } from "./labels.ts";
export type { Usage, ProbeResult } from "./probe.ts";
export type { BlockAnalysis, Edge } from "./graph.ts";
export type { Summary, Hotspot, ContractHotspot } from "./aggregate.ts";
export type { PageComparison, FalseSharingPage } from "./pages.ts";
