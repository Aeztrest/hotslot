import {
  aggregate,
  combineProbes,
  isPrecompile,
  comparePages,
  labelPage,
  labelContract,
  labelSlot,
  keyKind,
  parseKey,
  chainLength,
  contractKeys,
  type ContractHotspot,
  type FocusReport,
  type Summary,
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
  /** Report on this contract specifically (scan --contract): its slots are always probed. */
  focus?: string;
  /** Per block, indices of txs that touched the focus contract (directly or through another contract). */
  focusTxs?: Map<number, Set<number>>;
  /** Names for contracts that have no name() (simulation: the deployed contract). */
  names?: Map<string, string>;
  log: (msg: string) => void;
}

async function focusReport(
  analyses: BlockAnalysis[],
  summary: Summary,
  contracts: ContractHotspot[],
  address: string,
  label: (a: string) => Promise<ContractLabel | null>,
  usedBy?: Map<number, Set<number>>,
): Promise<FocusReport> {
  let txsTo = 0;
  let waitedTo = 0;
  const blockedBy = new Map<string, number>();
  for (const b of analyses) {
    const incoming = new Map<number, Set<string>>();
    for (const e of b.edges) {
      const s = incoming.get(e.to) ?? new Set<string>();
      incoming.set(e.to, s);
      for (const k of e.keys) s.add(keyKind(k) === "nonce" ? "sender" : parseKey(k).address);
    }
    b.txs.forEach((t, i) => {
      if (t.to?.toLowerCase() !== address && !usedBy?.get(b.number)?.has(i)) return;
      txsTo += 1;
      const why = incoming.get(i);
      if (!why) return;
      waitedTo += 1;
      for (const a of why) blockedBy.set(a, (blockedBy.get(a) ?? 0) + 1);
    });
  }
  const c = contracts.find((x) => x.address === address);
  const path = analyses.reduce((s, b) => s + b.pathLength, 0);
  const cost = analyses.reduce((s, b) => s + b.pathCost, 0);
  const total = analyses.reduce((s, b) => s + b.totalCost, 0);
  const alone = summary.txs / (path - (c?.stepsAdded ?? 0));
  // Contracts are often hot together (the same txs share state in both), so fixing one alone gains
  // nothing. Find the partner whose joint fix gains most.
  const fixedWith = (partner: string) => {
    const ignore = contractKeys([address, partner]);
    let p = 0;
    let g = 0;
    for (const b of analyses) {
      const r = chainLength(b.txCount, b.edges, ignore, b.txs.map((t) => t.cost));
      p += r.length;
      g += r.cost;
    }
    return { parallelism: summary.txs / p, costParallelism: total / g };
  };
  let withPartner: FocusReport["withPartner"] = null;
  for (const other of contracts.slice(0, 10)) {
    if (other.address === address || BigInt(other.address) < 0x10000n) continue;
    const r = fixedWith(other.address);
    if (r.parallelism > alone * 1.05 && (!withPartner || r.parallelism > withPartner.parallelism)) {
      withPartner = { address: other.address, label: null, ...r };
    }
  }
  if (withPartner) withPartner.label = await label(withPartner.address);
  return {
    address,
    label: await label(address),
    txsTo,
    waitedTo,
    blockedBy: await Promise.all(
      [...blockedBy].sort((x, y) => y[1] - x[1]).slice(0, 8).map(async ([a, waits]) => ({ address: a, label: a === "sender" ? null : await label(a), waits })),
    ),
    waitsOnItsState: c?.waits ?? 0,
    parallelismIfFixed: alone,
    costParallelismIfFixed: total / (cost - (c?.costAdded ?? 0)),
    withPartner,
  };
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

  // Hot state, grouped by contract: the top slots of each of the worst contracts, and its MON balance if
  // payments into it made txs wait. Nonces are not listed: one sender's own ordering is nothing to fix.
  const slotsPerContract = 8;
  const focus = opts.focus?.toLowerCase();
  const topContracts = [...new Set([...(focus ? [focus] : []), ...contracts.slice(0, 12).map((c) => c.address)])];
  const topStorage = topContracts.flatMap((a) => hotspots.filter((h) => h.kind !== "nonce" && h.address === a).slice(0, slotsPerContract));
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
    slotLabel: h.kind === "balance" ? "MON balance" : labelSlot(h.slot, opts.layouts?.get(h.address), opts.mappingKeys),
  }));

  // Precompiles have no EVM code reading their storage, so overriding a slot there proves nothing.
  const probeContracts = topContracts.filter((a) => !isPrecompile(a)).slice(0, opts.probeTop);
  const toProbe = probeContracts.flatMap((a) => reportHotspots.filter((h) => h.address === a && h.kind === "storage").slice(0, opts.probeSlots));
  if (toProbe.length) opts.log(`root-causing ${toProbe.length} slots across ${probeContracts.length} contracts by replay (${opts.probeSamples} txs each)…`);
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
      balancePathLength: b.balancePathLength,
      noncePathLength: b.noncePathLength,
      conflictedTxs: b.conflictedTxs,
      totalCost: b.totalCost,
      pathCost: b.pathCost,
      storagePathCost: b.storagePathCost,
      maxTxCost: b.maxTxCost,
    })),
    hotspots: reportHotspots,
    focus: focus ? await focusReport(analyses, summary, contracts, focus, label, opts.focusTxs) : undefined,
    contracts: labeledContracts,
    showcase,
    pages,
  };
}
