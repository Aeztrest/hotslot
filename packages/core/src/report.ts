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
  blocks: { number: number; txCount: number; pathLength: number; storagePathLength: number; accountPathLength: number; conflictedTxs: number }[];
  hotspots: ReportHotspot[];
  contracts: (ContractHotspot & { label: ContractLabel | null })[];
  /** A few blocks with their full dependency graph, for the graph view. */
  showcase: BlockAnalysis[];
  /**
   * The same blocks analyzed with MIP-8 page granularity (conflicts per 128-slot page instead of per
   * slot). MIP-8 does not specify which one parallel execution uses, so both are reported.
   */
  pages?: Omit<PageComparison, "falseSharing"> & { falseSharing: (FalseSharingPage & { label: ContractLabel | null; pageLabel: string })[] };
  /** Simulation only: what was run. */
  scenario?: { contract: string; users: number; action: string; description: string };
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
