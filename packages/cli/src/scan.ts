import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Rpc, analyzeBlock, fetchBlockAccess, mapLimit, type BlockAnalysis } from "@hotslot/core";
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
}

export async function scan(args: ScanArgs): Promise<void> {
  const rpc = new Rpc(args.rpc);
  const head = args.to ?? Number(await rpc.call<string>("eth_blockNumber", [])) - 2;
  const numbers = Array.from({ length: args.blocks }, (_, i) => head - args.blocks + 1 + i);
  const miners = new Map<number, string>();
  let done = 0;

  log(`scanning ${numbers.length} blocks (${numbers[0]}–${head}) on ${args.rpc}`);
  const results = await mapLimit(numbers, args.concurrency, async (n) => {
    try {
      const { block, txs } = await fetchBlockAccess(rpc, n);
      miners.set(n, block.miner.toLowerCase());
      return analyzeBlock(n, Number(block.timestamp), txs);
    } catch (err) {
      log(`  block ${n} skipped: ${(err as Error).message}`);
      return null;
    } finally {
      if (++done % 25 === 0 || done === numbers.length) log(`  ${done}/${numbers.length}`);
    }
  });
  const analyses = results.filter((r): r is BlockAnalysis => r !== null && r.txCount > 0);
  if (analyses.length === 0) throw new Error("no blocks with transactions in range");

  const report = await buildReport(rpc, analyses, {
    kind: "network",
    title: "Monad mainnet: parallelism lost to shared state",
    probeTop: args.probeTop,
    probeSlots: args.probeSlots,
    probeSamples: args.probeSamples,
    miners,
    log,
  });
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report));
  printReport(report);
  log(`report written to ${args.out}`);
}

function log(msg: string) {
  process.stderr.write(msg + "\n");
}
