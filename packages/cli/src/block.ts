import {
  AVOIDABLE,
  Rpc,
  USAGE_INFO,
  analyzeBlock,
  fetchBlockAccess,
  isStorageKey,
  labelContract,
  mapLimit,
  parseKey,
  probeSlot,
  shortAddr,
  shortSlot,
  toPageAccess,
  type StateKey,
} from "@hotslot/core";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** Explain one block: its critical path, step by step, and the slots that made txs wait. */
export async function block(opts: { rpc: string; number?: number; probe: number }): Promise<void> {
  const rpc = new Rpc(opts.rpc);
  const n = opts.number ?? Number(await rpc.call<string>("eth_blockNumber", [])) - 2;
  const { block, txs } = await fetchBlockAccess(rpc, n);
  const a = analyzeBlock(n, Number(block.timestamp), txs);
  const pages = analyzeBlock(n, Number(block.timestamp), txs.map(toPageAccess));

  const addresses = new Set<string>();
  for (const e of a.edges) for (const k of e.keys) addresses.add(parseKey(k).address);
  for (const t of txs) if (t.to) addresses.add(t.to);
  const names = new Map<string, string>();
  await mapLimit([...addresses], 6, async (addr) => {
    const l = await labelContract(rpc, addr).catch(() => null);
    names.set(addr, l?.name ?? shortAddr(addr));
  });
  const keyName = (k: StateKey) => {
    const { address, slot } = parseKey(k);
    const who = names.get(address) ?? shortAddr(address);
    return isStorageKey(k) ? `${who} ${shortSlot(slot)}` : `${who} ${slot}`;
  };

  const out: string[] = [""];
  out.push(bold(`block ${n.toLocaleString("en-US")}`) + dim(` · ${a.txCount} txs · chain ${await rpc.call<string>("eth_chainId", []).then(Number)}`));
  out.push(`  longest dependency chain  ${bold(String(a.pathLength))} of ${a.txCount} txs → parallelism ${bold((a.txCount / Math.max(1, a.pathLength)).toFixed(2) + "x")}`);
  out.push(`  txs that waited           ${a.conflictedTxs}`);
  out.push(`  storage-only chain        ${a.storagePathLength}   ${dim("same-account-only chain")} ${a.accountPathLength}   ${dim("per MIP-8 page")} ${pages.pathLength}`);
  out.push("");

  if (a.criticalPath.length > 1) {
    out.push(bold("  critical path") + dim("  (each tx had to wait for the one above it)"));
    const edgeOf = new Map(a.edges.map((e) => [`${e.from}-${e.to}`, e]));
    for (let i = 0; i < a.criticalPath.length; i++) {
      const t = a.criticalPath[i];
      const tx = a.txs[t];
      const callee = tx.to ? names.get(tx.to) ?? shortAddr(tx.to) : "create";
      const head = `  ${String(t).padStart(4)}  ${tx.hash.slice(0, 12)}…  → ${callee}${tx.system ? dim(" (system)") : ""}`;
      if (i === 0) {
        out.push(head);
        continue;
      }
      const e = edgeOf.get(`${a.criticalPath[i - 1]}-${t}`)!;
      const why = e.keys.slice(0, 2).map(keyName).join(", ") + (e.keys.length > 2 ? dim(` +${e.keys.length - 2} more`) : "");
      out.push(`${head}\n        ${dim("waited on")} ${why}`);
    }
    out.push("");
  }

  const waits = new Map<StateKey, number[]>();
  for (const e of a.edges) for (const k of e.keys) if (isStorageKey(k)) (waits.get(k) ?? waits.set(k, []).get(k)!).push(e.to);
  const hot = [...waits].sort((x, y) => y[1].length - x[1].length).slice(0, 8);
  if (hot.length) {
    out.push(bold("  storage slots that made txs wait"));
    const verdicts = new Map<StateKey, string>();
    if (opts.probe > 0) {
      await mapLimit(hot.slice(0, opts.probe), 3, async ([k, waiters]) => {
        const { address, slot } = parseKey(k);
        if (BigInt(address) < 0x10000n) return verdicts.set(k, dim("precompile, not replayed"));
        const txIndex = waiters[0];
        const raw = block.transactions[txIndex];
        const r = await probeSlot(rpc, raw, n, txIndex, address, slot, block.miner.toLowerCase());
        verdicts.set(k, r.usage ? (AVOIDABLE.has(r.usage) ? green(`${USAGE_INFO[r.usage].title} · avoidable`) : `${USAGE_INFO[r.usage].title} · inherent`) : dim(r.skipped ?? ""));
      });
    }
    for (const [k, w] of hot) out.push(`  ${String(w.length).padStart(5)} waits  ${keyName(k).padEnd(44).slice(0, 44)} ${verdicts.get(k) ?? ""}`);
    out.push("");
  }
  console.log(out.join("\n"));
}
