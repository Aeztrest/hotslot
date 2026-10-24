#!/usr/bin/env node
import { parseArgs } from "node:util";
import { scan } from "./scan.ts";
import { simulate } from "./simulate.ts";

const USAGE = `hotslot - find the storage slots that stop Monad from running transactions in parallel

usage:
  hotslot scan [--blocks 300] [--to <block>] [--rpc <url>] [--out data/mainnet.json]
               [--probe-top 6] [--probe-slots 4] [--probe-samples 3] [--concurrency 4]
      Analyze recent blocks: dependency graphs, parallelism, hottest slots, and why they are hot.
      --probe-top/--probe-slots: replay the hottest slots of the top N contracts to find the root cause.

  hotslot simulate <scenario.json> [--users 64] [--out data/sim-<name>.json]
      Deploy a contract on a local anvil chain, have N users call it in the same block,
      and report how parallel that block is - before you deploy for real.
`;

const DEFAULT_RPC = "https://rpc.monad.xyz";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "scan") {
    const { values } = parseArgs({
      args: rest,
      options: {
        rpc: { type: "string", default: DEFAULT_RPC },
        blocks: { type: "string", default: "300" },
        to: { type: "string" },
        out: { type: "string", default: "data/mainnet.json" },
        "probe-top": { type: "string", default: "6" },
        "probe-slots": { type: "string", default: "4" },
        "probe-samples": { type: "string", default: "3" },
        concurrency: { type: "string", default: "4" },
      },
    });
    await scan({
      rpc: values.rpc,
      blocks: Number(values.blocks),
      to: values.to ? Number(values.to) : undefined,
      out: values.out,
      probeTop: Number(values["probe-top"]),
      probeSlots: Number(values["probe-slots"]),
      probeSamples: Number(values["probe-samples"]),
      concurrency: Number(values.concurrency),
    });
  } else if (command === "simulate") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { users: { type: "string" }, out: { type: "string" } },
    });
    if (!positionals[0]) throw new Error("simulate needs a scenario file");
    await simulate({ scenario: positionals[0], users: values.users ? Number(values.users) : undefined, out: values.out });
  } else {
    process.stdout.write(USAGE);
    process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
