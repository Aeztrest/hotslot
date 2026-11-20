import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { findFoundryRoot, type Action, type Scenario } from "./simulate.ts";

interface AbiParam {
  type: string;
  components?: AbiParam[];
}
interface AbiItem {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiParam[];
}

/**
 * Write a starting scenario for a contract: every state-changing function becomes an action with
 * placeholder arguments. The first one is enabled (weight 1), the rest disabled (weight 0).
 */
export async function init(opts: { contract?: string; root?: string; out?: string }): Promise<void> {
  const root = opts.root ? resolve(opts.root) : findFoundryRoot(process.cwd());
  execFileSync("forge", ["build", "--root", root], { stdio: ["ignore", "ignore", "inherit"] });
  const outDir = join(root, "out");
  const names = (await readdir(outDir)).filter((d) => d.endsWith(".sol"));
  if (!opts.contract) {
    const available = names.map((d) => d.slice(0, -4)).filter((n) => !/^(Test|Script|Vm|console|Std|safeconsole)/.test(n) && !n.endsWith(".t") && !n.endsWith(".s"));
    throw new Error(`which contract? usage: hotslot init <Contract>\n  contracts in ${root}: ${available.join(", ")}`);
  }
  const path = names.map((d) => join(outDir, d, `${opts.contract}.json`)).find(existsSync);
  if (!path) throw new Error(`no contract named ${opts.contract} in ${outDir}`);
  const abi = (JSON.parse(await readFile(path, "utf8")) as { abi: AbiItem[] }).abi;

  const fns = abi.filter((x) => x.type === "function" && x.stateMutability !== "view" && x.stateMutability !== "pure");
  if (!fns.length) throw new Error(`${opts.contract} has no state-changing functions`);
  const ctor = abi.find((x) => x.type === "constructor");
  const actions: Action[] = fns.map((f, i) => ({
    signature: `${f.name}(${(f.inputs ?? []).map(typeOf).join(",")})`,
    args: (f.inputs ?? []).map(placeholder),
    ...(f.stateMutability === "payable" ? { value: "0.01" } : {}),
    weight: i === 0 ? 1 : 0,
  }));
  const scenario: Scenario = {
    name: opts.contract.toLowerCase(),
    description: `${opts.contract}: users calling it in the same block`,
    contract: opts.contract,
    ...(ctor?.inputs?.length ? { constructorArgs: ctor.inputs.map(placeholder) } : {}),
    ...(ctor?.stateMutability === "payable" ? { deployValue: "0" } : {}),
    users: 64,
    setup: [],
    actions,
  };
  const out = resolve(opts.out ?? join(root, "hotslot", `${scenario.name}.json`));
  if (existsSync(out)) throw new Error(`${out} already exists`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(scenario, null, 2) + "\n");
  const rel = relative(process.cwd(), out) || out;
  process.stderr.write(
    [
      `wrote ${rel}`,
      ``,
      `  ${fns.length} state-changing functions are listed under "actions". Next:`,
      `  1. set "weight" on the ones your users call (weight 3 vs 1 = three times as many users), and fill in args`,
      `     ("$user" = the caller's address, "$contract" = the contract's);`,
      `  2. add anything users must do first (approve, deposit) to "setup";`,
      `  3. run: hotslot simulate ${rel}`,
      ``,
    ].join("\n"),
  );
}

function typeOf(p: AbiParam): string {
  if (p.type.startsWith("tuple")) return `(${(p.components ?? []).map(typeOf).join(",")})${p.type.slice(5)}`;
  return p.type;
}

/** A plausible argument for a parameter; "$user" for addresses, since most per-user calls take the caller. */
function placeholder(p: AbiParam): string {
  const t = p.type;
  if (t.endsWith("]")) return "TODO";
  if (t === "address") return "$user";
  if (/^u?int/.test(t)) return "1";
  if (t === "bool") return "true";
  if (t.startsWith("bytes")) return t === "bytes" ? "0x" : "0x" + "00".repeat(Number(t.slice(5)));
  if (t === "string") return "hello";
  return "TODO";
}
