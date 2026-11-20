import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Rpc, analyzeBlock, fetchBlockAccess, mapLimit, toPageAccess, type BlockAnalysis, type Report } from "@hotslot/core";
import { buildReport } from "./build.ts";
import { printReport } from "./print.ts";

export interface ScanArgs {
  rpc: string;
  blocks: number;
  to?: number;
  out: string;
  probeTop: number;
  probeSlots: number;
  probeSamples: number;
  concurrency: number;
  /** Report on this contract specifically. */
  contract?: string;
}

export async function scan(args: ScanArgs): Promise<Report> {
  const rpc = new Rpc(args.rpc);
  const head = args.to ?? Number(await rpc.call<string>("eth_blockNumber", [])) - 2;
  const numbers = Array.from({ length: args.blocks }, (_, i) => head - args.blocks + 1 + i);
  const miners = new Map<number, string>();
  const focusTxs = new Map<number, Set<number>>();
  let done = 0;
  // The cost model claims a lower bound on gas used, and gas used never exceeds the gas limit. A tx whose
  // estimate is above its limit is proof the model over-counts, so every scan checks it.
  const bound = { checked: 0, over: [] as string[] };

  log(`scanning ${numbers.length} blocks (${numbers[0]}–${head}) on ${args.rpc}`);
  const results = await mapLimit(numbers, args.concurrency, async (n) => {
    try {
      const { block, txs } = await fetchBlockAccess(rpc, n);
      miners.set(n, block.miner.toLowerCase());
      if (args.contract) focusTxs.set(n, new Set(txs.filter((t) => t.accounts?.includes(args.contract!)).map((t) => t.index)));
      for (const t of txs) {
        if (t.system) continue;
        bound.checked += 1;
        if (t.cost > t.gasLimit) bound.over.push(`${t.hash} (estimate ${t.cost}, limit ${t.gasLimit})`);
      }
      const ts = Number(block.timestamp);
      return { slot: analyzeBlock(n, ts, txs), page: analyzeBlock(n, ts, txs.map(toPageAccess)) };
    } catch (err) {
      log(`  block ${n} skipped: ${(err as Error).message}`);
      return null;
    } finally {
      if (++done % 25 === 0 || done === numbers.length) log(`  ${done}/${numbers.length}`);
    }
  });
  const kept = results.filter((r): r is { slot: BlockAnalysis; page: BlockAnalysis } => r !== null && r.slot.txCount > 0);
  if (kept.length === 0) throw new Error("no blocks with transactions in range");
  if (bound.over.length === 0) log(`cost model: estimate <= gas limit on all ${bound.checked} txs`);
  else log(`warning: cost estimate exceeds the gas limit on ${bound.over.length} of ${bound.checked} txs, e.g.\n  ${bound.over.slice(0, 5).join("\n  ")}`);
  const analyses = kept.map((r) => r.slot);
  const pageAnalyses = kept.map((r) => r.page);

  const report = await buildReport(rpc, analyses, pageAnalyses, {
    kind: "network",
    title: "Monad mainnet: parallelism lost to shared state",
    probeTop: args.probeTop,
    probeSlots: args.probeSlots,
    probeSamples: args.probeSamples,
    miners,
    focus: args.contract,
    focusTxs,
    log,
  });
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report));
  printReport(report);
  log(`report written to ${args.out}`);
  return report;
}

function log(msg: string) {
  process.stderr.write(msg + "\n");
}
