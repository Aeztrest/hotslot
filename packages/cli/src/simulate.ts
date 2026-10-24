import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { encodeFunctionData, parseAbiItem, parseEther, type AbiFunction, type Hex } from "viem";
import { Rpc, analyzeBlock, fetchBlockAccess, type LayoutEntry } from "@hotslot/core";
import { buildReport } from "./build.ts";
import { printReport } from "./print.ts";

interface Scenario {
  name: string;
  description: string;
  /** Contract name in contracts/src; built with forge. */
  contract: string;
  /** Constructor args, ABI-encoded by the artifact's ABI. */
  constructorArgs?: unknown[];
  /** MON sent with the deployment, in whole MON. */
  deployValue?: string;
  users: number;
  /** What every user calls, all in one block. "$user" in args is replaced by the caller's address. */
  action: { signature: string; args: string[]; value?: string };
}

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
  storageLayout: { storage: LayoutEntry[] };
}

export async function simulate(opts: { scenario: string; users?: number; out?: string }): Promise<void> {
  const scenarioPath = resolve(opts.scenario);
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as Scenario;
  const users = opts.users ?? scenario.users;
  const contractsRoot = resolve(dirname(scenarioPath), "..");

  log(`building ${scenario.contract} with forge…`);
  execFileSync("forge", ["build", "--root", contractsRoot], { stdio: ["ignore", "ignore", "inherit"] });
  const artifact = JSON.parse(
    await readFile(join(contractsRoot, "out", `${scenario.contract}.sol`, `${scenario.contract}.json`), "utf8"),
  ) as Artifact;

  const port = 18545 + Math.floor(Math.random() * 1000);
  const anvil = await startAnvil(port, users + 1);
  try {
    const rpc = new Rpc(`http://127.0.0.1:${port}`);
    const accounts = await rpc.call<string[]>("eth_accounts", []);
    const [deployer, ...players] = accounts;

    const ctorArgs = scenario.constructorArgs?.length ? encodeCtorArgs(artifact.abi, scenario.constructorArgs) : "";
    const deployHash = await rpc.call<string>("eth_sendTransaction", [
      {
        from: deployer,
        data: artifact.bytecode.object + ctorArgs,
        value: toHex(parseEther(scenario.deployValue ?? "0")),
        gas: "0x1c9c380",
      },
    ]);
    const deployReceipt = await rpc.call<{ contractAddress: string; status: string }>("eth_getTransactionReceipt", [deployHash]);
    if (deployReceipt.status !== "0x1") throw new Error("deployment reverted");
    const contract = deployReceipt.contractAddress.toLowerCase();
    log(`deployed ${scenario.contract} at ${contract}`);

    // Queue every user's call, then mine them as a single block.
    await rpc.call("evm_setAutomine", [false]);
    const fn = parseAbiItem(`function ${scenario.action.signature}`) as AbiFunction;
    const hashes: string[] = [];
    for (const player of players.slice(0, users)) {
      const args = scenario.action.args.map((a) => (a === "$user" ? player : a));
      hashes.push(
        await rpc.call<string>("eth_sendTransaction", [
          {
            from: player,
            to: contract,
            data: encodeFunctionData({ abi: [fn], functionName: fn.name, args }),
            value: toHex(parseEther(scenario.action.value ?? "0")),
            gas: "0x7a120",
          },
        ]),
      );
    }
    await rpc.call("evm_mine", []);
    const blockNumber = Number(await rpc.call<string>("eth_blockNumber", []));

    const { block, txs } = await fetchBlockAccess(rpc, blockNumber);
    if (txs.length !== users) throw new Error(`expected ${users} txs in block ${blockNumber}, got ${txs.length}`);
    const failed = (await Promise.all(hashes.map((h) => rpc.call<{ status: string }>("eth_getTransactionReceipt", [h])))).filter(
      (r) => r.status !== "0x1",
    ).length;
    if (failed) log(`warning: ${failed} of ${users} calls reverted`);
    log(`mined ${users} calls in block ${blockNumber}`);

    const analysis = analyzeBlock(blockNumber, Number(block.timestamp), txs);
    const report = await buildReport(rpc, [analysis], {
      kind: "simulation",
      title: `${scenario.contract}: ${users} users in one block`,
      probeTop: 3,
      probeSlots: 6,
      probeSamples: 3,
      miners: new Map([[blockNumber, block.miner.toLowerCase()]]),
      layouts: new Map([[contract, artifact.storageLayout.storage]]),
      mappingKeys: players.slice(0, users),
      names: new Map([[contract, scenario.contract]]),
      log,
    });
    report.scenario = {
      contract: scenario.contract,
      users,
      action: scenario.action.signature,
      description: scenario.description,
    };

    const out = opts.out ?? resolve(contractsRoot, "..", "data", `sim-${scenario.name}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(report));
    printReport(report);
    log(`report written to ${out}`);
  } finally {
    anvil.kill();
  }
}

function encodeCtorArgs(abi: unknown[], args: unknown[]): string {
  const ctor = (abi as { type: string; inputs: { type: string }[] }[]).find((x) => x.type === "constructor")!;
  const fake = { type: "function", name: "ctor", inputs: ctor.inputs, outputs: [], stateMutability: "nonpayable" } as AbiFunction;
  return encodeFunctionData({ abi: [fake], functionName: "ctor", args }).slice(10);
}

async function startAnvil(port: number, accounts: number): Promise<ChildProcess> {
  const child = spawn(
    "anvil",
    [
      "--port", String(port),
      "--accounts", String(accounts),
      "--balance", "1000000",
      "--gas-limit", "3000000000",
      "--order", "fifo",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  const rpc = new Rpc(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 50; i++) {
    try {
      await rpc.call("eth_chainId", [], 0);
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill();
  throw new Error("anvil did not start (is foundry installed?)");
}

const toHex = (v: bigint) => "0x" + v.toString(16);

function log(msg: string) {
  process.stderr.write(msg + "\n");
}
