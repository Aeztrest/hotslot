import {
  aggregate,
  combineProbes,
  comparePages,
  labelPage,
  labelContract,
  labelSlot,
  mapLimit,
  probeSlot,
  type BlockAnalysis,
  type ContractLabel,
  type LayoutEntry,
  type RawTx,
  type Report,
  type ReportHotspot,
  type Rpc,
} from "@hotslot/core";

function isPrecompile(address: string): boolean {
  return BigInt(address) < 0x10000n;
}

export interface BuildOptions {
  kind: Report["kind"];
  title: string;
  /** Root-cause the hottest slots of this many contracts by replay… */
  probeTop: number;
  /** …this many slots per contract. */
  probeSlots: number;
  /** Sample transactions replayed per hotspot. */
  probeSamples: number;
  /** Fee recipient per block, needed to ignore fee payments when diffing replays. */
  miners: Map<number, string>;
  /** Simulation mode: storage layout per contract address, and addresses to resolve mapping slots. */
  layouts?: Map<string, LayoutEntry[]>;
  mappingKeys?: string[];
  /** Names for contracts that have no name() (simulation: the deployed contract). */
  names?: Map<string, string>;
  log: (msg: string) => void;
}

export async function buildReport(
  rpc: Rpc,
  analyses: BlockAnalysis[],
  /** The same blocks analyzed per MIP-8 page instead of per slot. */
  pageAnalyses: BlockAnalysis[],
  opts: BuildOptions,
): Promise<Report> {
  const { summary, hotspots, contracts } = aggregate(analyses);
  const chainId = Number(await rpc.call<string>("eth_chainId", []));

  // Hot slots, grouped by contract: the top slots of each of the worst contracts.
  const slotsPerContract = 8;
  const topContracts = contracts.slice(0, 12).map((c) => c.address);
  const topStorage = topContracts.flatMap((a) => hotspots.filter((h) => h.isStorage && h.address === a).slice(0, slotsPerContract));
  const labelCache = new Map<string, Promise<ContractLabel | null>>();
  const label = (a: string) => {
    const known = opts.names?.get(a);
    if (known) return Promise.resolve<ContractLabel>({ address: a, name: known, symbol: null, isProxy: false });
    if (!labelCache.has(a)) labelCache.set(a, labelContract(rpc, a).catch(() => null));
    return labelCache.get(a)!;
  };

  const reportHotspots: ReportHotspot[] = await mapLimit(topStorage, 4, async (h) => ({
    ...h,
    label: await label(h.address),
    slotLabel: labelSlot(h.slot, opts.layouts?.get(h.address), opts.mappingKeys),
  }));

  // Precompiles have no EVM code reading their storage, so overriding a slot there proves nothing.
  const probeContracts = topContracts.filter((a) => !isPrecompile(a)).slice(0, opts.probeTop);
  const toProbe = probeContracts.flatMap((a) => reportHotspots.filter((h) => h.address === a).slice(0, opts.probeSlots));
  opts.log(`root-causing ${toProbe.length} slots across ${probeContracts.length} contracts by replay (${opts.probeSamples} txs each)…`);
  await mapLimit(toProbe, 3, async (h, i) => {
    const samples = h.samples.slice(0, opts.probeSamples);
    const results = await mapLimit(samples, 2, async (s) => {
      const tx = await rpc.call<RawTx>("eth_getTransactionByHash", [s.hash]);
      return probeSlot(rpc, tx, s.block, s.txIndex, h.address, h.slot, opts.miners.get(s.block) ?? "0x0");
    });
    h.probe = { ...combineProbes(results), results };
    opts.log(`  [${i + 1}/${toProbe.length}] ${h.label?.name ?? h.address} ${h.slotLabel}: ${h.probe.usage ?? "unclassified"}`);
  });

  const labeledContracts = await mapLimit(contracts.slice(0, 20), 4, async (c) => ({ ...c, label: await label(c.address) }));

  const cmp = comparePages(analyses, pageAnalyses);
  const pages: Report["pages"] = {
    ...cmp,
    falseSharing: await mapLimit(cmp.falseSharing, 4, async (p) => ({
      ...p,
      label: await label(p.address),
      pageLabel: labelPage(p.page, opts.layouts?.get(p.address)),
    })),
  };

  // Showcase: the busiest blocks, which are the ones where parallelism matters most.
  const showcase = [...analyses].sort((a, b) => b.txCount - a.txCount || a.number - b.number).slice(0, 6);

  return {
    kind: opts.kind,
    title: opts.title,
    generatedAt: new Date().toISOString(),
    rpc: rpc.url,
    chainId,
    summary,
    blocks: analyses.map((b) => ({
      number: b.number,
      txCount: b.txCount,
      pathLength: b.pathLength,
      storagePathLength: b.storagePathLength,
      accountPathLength: b.accountPathLength,
      conflictedTxs: b.conflictedTxs,
    })),
    hotspots: reportHotspots,
    contracts: labeledContracts,
    showcase,
    pages,
  };
}
