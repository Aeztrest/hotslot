#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Report } from "@hotslot/core";
import pkg from "../package.json" with { type: "json" };
import { block } from "./block.ts";
import { init } from "./init.ts";
import { scan } from "./scan.ts";
import { simulate } from "./simulate.ts";

const USAGE = `hotslot - find the state that stops Monad from running your transactions in parallel

  hotslot init <Contract> [--root <foundry project>]
      Write a scenario for one of your contracts (hotslot/<contract>.json) from its ABI.

  hotslot simulate <scenario.json> [--users 64] [--root <dir>] [--out <file>] [--min-parallelism <x>]
      Deploy the contract on a local anvil chain, have N users call it in the same block, and report
      how parallel that block is, which slots made calls wait, and how to fix them.
      --min-parallelism: exit with code 1 below this (for CI).

  hotslot scan [--contract <address>] [--blocks 300] [--to <block>] [--rpc <url>] [--out <file>]
               [--probe-top 6] [--probe-slots 4] [--probe-samples 3] [--concurrency 4] [--min-parallelism <x>]
      Analyze recent blocks: parallelism, the contracts and slots that make txs wait, and why.
      --contract: also report how that contract's users fare and what fixing it would gain.

  hotslot block [<number>] [--rpc <url>] [--probe 4]
      Explain one block (default: latest): its critical path step by step and the state that made
      transactions wait.

  --rpc defaults to ${"https://rpc.monad.xyz"}; it must serve debug_traceBlockByNumber (prestateTracer).
`;

const DEFAULT_RPC = "https://rpc.monad.xyz";

async function main() {
  // `pnpm hotslot …` runs in the hotslot repo; resolve the user's paths from where they ran it.
  if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--version" || command === "-v") return void process.stdout.write(`${pkg.version}
`);
  if (command === "scan") {
    const { values } = parseArgs({
      args: rest,
      options: {
        rpc: { type: "string", default: DEFAULT_RPC },
        blocks: { type: "string", default: "300" },
        to: { type: "string" },
        out: { type: "string", default: "hotslot-reports/mainnet.json" },
        contract: { type: "string" },
        "probe-top": { type: "string", default: "6" },
        "probe-slots": { type: "string", default: "4" },
        "probe-samples": { type: "string", default: "3" },
        concurrency: { type: "string", default: "4" },
        "min-parallelism": { type: "string" },
      },
    });
    if (values.contract && !/^0x[0-9a-fA-F]{40}$/.test(values.contract)) throw new Error(`--contract: not an address: ${values.contract}`);
    const report = await scan({
      rpc: values.rpc,
      blocks: num("--blocks", values.blocks),
      to: values.to ? num("--to", values.to) : undefined,
      out: values.out,
      contract: values.contract?.toLowerCase(),
      probeTop: num("--probe-top", values["probe-top"]),
      probeSlots: num("--probe-slots", values["probe-slots"]),
      probeSamples: num("--probe-samples", values["probe-samples"]),
      concurrency: num("--concurrency", values.concurrency),
    });
    gate(report, values["min-parallelism"]);
  } else if (command === "block") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { rpc: { type: "string", default: DEFAULT_RPC }, probe: { type: "string", default: "4" } },
    });
    await block({ rpc: values.rpc, number: positionals[0] ? num("block", positionals[0]) : undefined, probe: num("--probe", values.probe) });
  } else if (command === "simulate") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { users: { type: "string" }, out: { type: "string" }, root: { type: "string" }, "min-parallelism": { type: "string" } },
    });
    if (!positionals[0]) throw new Error("simulate needs a scenario file (create one with: hotslot init <Contract>)");
    const report = await simulate({
      scenario: positionals[0],
      users: values.users ? num("--users", values.users) : undefined,
      out: values.out,
      root: values.root,
    });
    gate(report, values["min-parallelism"]);
  } else if (command === "init") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { root: { type: "string" }, out: { type: "string" } } });
    await init({ contract: positionals[0], root: values.root, out: values.out });
  } else {
    process.stdout.write(USAGE);
    process.exit(command && command !== "help" && command !== "--help" && command !== "-h" ? 1 : 0);
  }
}

/** CI gate: fail when parallelism is below the threshold. */
function gate(report: Report, min: string | undefined) {
  if (min === undefined) return;
  const threshold = num("--min-parallelism", min);
  const actual = report.summary.effectiveParallelism;
  if (actual < threshold) {
    process.stderr.write(`FAIL: parallelism ${actual.toFixed(2)}x is below --min-parallelism ${threshold}x\n`);
    process.exit(1);
  }
  process.stderr.write(`ok: parallelism ${actual.toFixed(2)}x >= ${threshold}x\n`);
}

function num(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: not a number: ${v}`);
  return n;
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
