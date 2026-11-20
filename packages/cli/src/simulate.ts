import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { encodeFunctionData, parseAbiItem, parseEther, type AbiFunction, type Hex } from "viem";
import { Rpc, analyzeBlock, fetchBlockAccess, toPageAccess, type LayoutEntry, type Report } from "@hotslot/core";
import { buildReport } from "./build.ts";
import { printReport } from "./print.ts";

/** One call. In `args`, "$user" is the calling user's address and "$contract" the deployed contract's. */
export interface Action {
  signature: string;
  args?: string[];
  /** MON sent with the call, in whole MON. */
  value?: string;
  /** Share of users making this call (default 1). Users are assigned round-robin by weight; 0 disables it. */
  weight?: number;
}

export interface Scenario {
  name: string;
  description?: string;
  /** Contract name, or "path/File.sol:Name" when the name is ambiguous. Built with forge. */
  contract: string;
  /** Constructor args, ABI-encoded by the artifact's ABI. */
  constructorArgs?: unknown[];
  /** MON sent with the deployment, in whole MON. */
  deployValue?: string;
  users: number;
  /** Calls every user makes first, each mined in its own block before the measured one (e.g. approve, deposit). */
  setup?: Action[];
  /** What users call in the measured block. */
  actions?: Action[];
  /** Single-action shorthand, same as `actions: [action]`. */
  action?: Action;
}

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
  storageLayout?: { storage: LayoutEntry[] };
}

export interface SimulateOptions {
  scenario: string;
  users?: number;
  out?: string;
  /** Foundry project root. Default: the nearest folder with a foundry.toml, from the scenario file up. */
  root?: string;
  minParallelism?: number;
  quiet?: boolean;
}

export async function simulate(opts: SimulateOptions): Promise<Report> {
  const scenarioPath = resolve(opts.scenario);
  if (!existsSync(scenarioPath)) throw new Error(`scenario not found: ${scenarioPath}`);
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as Scenario;
  const actions = (scenario.actions ?? (scenario.action ? [scenario.action] : [])).filter((a) => (a.weight ?? 1) > 0);
  if (!actions.length) throw new Error(`${opts.scenario}: no actions (add "actions": [{ "signature": "fn(uint256)", "args": ["1"] }])`);
  const users = opts.users ?? scenario.users ?? 64;
  const root = opts.root ? resolve(opts.root) : findFoundryRoot(dirname(scenarioPath));
  requireTool("forge");
  requireTool("anvil");

  log(`building ${scenario.contract} in ${root} with forge…`);
  try {
    execFileSync("forge", ["build", "--root", root, "--extra-output", "storageLayout"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`forge build failed:\n${(err as { stderr?: Buffer }).stderr?.toString().trim() ?? (err as Error).message}`);
  }
  const artifact = await loadArtifact(root, scenario.contract);
  const contractName = scenario.contract.split(":").at(-1)!;
  const layout = artifact.storageLayout?.storage;
  if (!layout) log("note: no storage layout in the artifact, slots will be shown by number");

  const port = 18545 + Math.floor(Math.random() * 1000);
  const anvil = await startAnvil(port, users + 1);
  try {
    const rpc = new Rpc(`http://127.0.0.1:${port}`);
    const accounts = await rpc.call<string[]>("eth_accounts", []);
    const [deployer, ...players] = accounts;
    const ctorArgs = scenario.constructorArgs?.length ? encodeCtorArgs(artifact.abi, scenario.constructorArgs) : "";
    const deployHash = await rpc.call<string>("eth_sendTransaction", [
      { from: deployer, data: artifact.bytecode.object + ctorArgs, value: toHex(parseEther(scenario.deployValue ?? "0")), gas: "0x1c9c380" },
    ]);
    const deployReceipt = await rpc.call<{ contractAddress: string; status: string }>("eth_getTransactionReceipt", [deployHash]);
    if (deployReceipt.status !== "0x1") throw new Error("deployment reverted (check constructorArgs and deployValue)");
    const contract = deployReceipt.contractAddress.toLowerCase();
    log(`deployed ${contractName} at ${contract}`);

    const send = (from: string, a: Action) => {
      const fn = parseAbiItem(`function ${a.signature}`) as AbiFunction;
      const args = (a.args ?? []).map((v) => (v === "$user" ? from : v === "$contract" ? contract : v));
      return rpc.call<string>("eth_sendTransaction", [
        { from, to: contract, data: encodeFunctionData({ abi: [fn], functionName: fn.name, args }), value: toHex(parseEther(a.value ?? "0")), gas: "0x7a120" },
      ]);
    };
    const reverted = async (hashes: string[]) =>
      (await Promise.all(hashes.map((h) => rpc.call<{ status: string }>("eth_getTransactionReceipt", [h])))).filter((r) => r.status !== "0x1").length;

    const who = players.slice(0, users);
    await rpc.call("evm_setAutomine", [false]);
    for (const a of scenario.setup ?? []) {
      const hashes = await Promise.all(who.map((p) => send(p, a)));
      await rpc.call("evm_mine", []);
      const failed = await reverted(hashes);
      if (failed) throw new Error(`setup ${a.signature} reverted for ${failed} of ${users} users`);
      log(`setup: ${users} × ${a.signature}`);
    }

    // The measured block: every user's call, interleaved by weight (weights 3,1 -> a a a b a a a b …).
    const pattern = actions.flatMap((a, i) => Array<number>(Math.max(1, Math.round(a.weight ?? 1))).fill(i));
    const assigned = who.map((_, i) => actions[pattern[i % pattern.length]]);
    const hashes: string[] = [];
    for (let i = 0; i < who.length; i++) hashes.push(await send(who[i], assigned[i]));
    await rpc.call("evm_mine", []);
    const blockNumber = Number(await rpc.call<string>("eth_blockNumber", []));

    const { block, txs } = await fetchBlockAccess(rpc, blockNumber);
    if (txs.length !== users) throw new Error(`expected ${users} txs in block ${blockNumber}, got ${txs.length}`);
    const failed = await reverted(hashes);
    if (failed === users) throw new Error(`all ${users} calls reverted: check the actions' args and value`);
    if (failed) log(`warning: ${failed} of ${users} calls reverted; reverted calls still read state, but write nothing`);
    const mix = actions.map((a) => `${assigned.filter((x) => x === a).length} × ${a.signature}`).join(", ");
    log(`mined ${mix} in block ${blockNumber}`);

    const analysis = analyzeBlock(blockNumber, Number(block.timestamp), txs);
    const pageAnalysis = analyzeBlock(blockNumber, Number(block.timestamp), txs.map(toPageAccess));
    // Candidate mapping keys for naming slots: the users, the contract, and every literal call argument.
    const literals = [...(scenario.setup ?? []), ...actions].flatMap((a) => a.args ?? []).filter((v) => !v.startsWith("$"));
    const report = await buildReport(rpc, [analysis], [pageAnalysis], {
      kind: "simulation",
      title: `${contractName}: ${users} users in one block`,
      probeTop: 3,
      probeSlots: 6,
      probeSamples: 3,
      miners: new Map([[blockNumber, block.miner.toLowerCase()]]),
      layouts: layout ? new Map([[contract, layout]]) : undefined,
      mappingKeys: [...who, contract, ...new Set(literals)],
      names: new Map([[contract, contractName]]),
      log,
    });
    report.scenario = { contract: contractName, users, action: actions.map((a) => a.signature).join(" + "), description: scenario.description ?? "" };

    const out = resolve(opts.out ?? join("hotslot-reports", `${scenario.name ?? contractName}.json`));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(report));
    if (!opts.quiet) printReport(report);
    log(`report written to ${out}`);
    return report;
  } finally {
    anvil.kill();
  }
}

/** Nearest folder at or above `from` that has a foundry.toml. */
export function findFoundryRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "foundry.toml"))) return dir;
    if (dirname(dir) === dir) throw new Error(`no foundry.toml found above ${from}; run inside your Foundry project or pass --root`);
  }
}

async function loadArtifact(root: string, contract: string): Promise<Artifact> {
  let out = "out";
  try {
    out = JSON.parse(execFileSync("forge", ["config", "--json", "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).out ?? out;
  } catch {
    // keep the default
  }
  const outDir = resolve(root, out);
  const [file, name] = contract.includes(":") ? [contract.split(":")[0].split(/[\\/]/).at(-1)!, contract.split(":")[1]] : [null, contract];
  const dirs = file ? [file] : (await readdir(outDir)).filter((d) => d.endsWith(".sol"));
  const found = dirs.map((d) => join(outDir, d, `${name}.json`)).filter(existsSync);
  if (found.length === 0) throw new Error(`no artifact for contract ${name} in ${outDir}`);
  if (found.length > 1) throw new Error(`contract name ${name} is ambiguous; use "contract": "src/File.sol:${name}"`);
  return JSON.parse(await readFile(found[0], "utf8")) as Artifact;
}

function requireTool(cmd: string): void {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${cmd} not found. hotslot simulate needs Foundry: https://getfoundry.sh`);
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
    ["--port", String(port), "--accounts", String(accounts), "--balance", "1000000", "--gas-limit", "3000000000", "--order", "fifo", "--silent"],
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
  throw new Error("anvil did not start");
}

const toHex = (v: bigint) => "0x" + v.toString(16);

function log(msg: string) {
  process.stderr.write(msg + "\n");
}
