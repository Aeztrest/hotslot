import { AVOIDABLE, BALANCE_INFO, USAGE_INFO, shortAddr, type Report, type Usage } from "@hotslot/core";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = wrap("2");
const bold = wrap("1");
const red = wrap("31");
const green = wrap("32");

export function printReport(r: Report): void {
  const s = r.summary;
  const out: string[] = [];
  const names = new Map(r.contracts.map((c) => [c.address, c.label?.name ?? shortAddr(c.address)]));
  out.push("");
  out.push(bold(r.title));
  out.push(dim(`blocks ${s.firstBlock}–${s.lastBlock} · ${s.blocks} blocks · ${s.txs} txs · chain ${r.chainId}`));
  out.push("");
  out.push(`  txs that waited       ${pct(s.conflictedShare)} had to wait on an earlier tx in the same block`);
  out.push(`  parallelism           ${bold(x(s.effectiveParallelism))} of ${x(s.idealParallelism)} possible  ${red(`(${pct(1 - s.effectiveParallelism / s.idealParallelism)} lost)`)}`);
  out.push(`  gas-weighted          ${bold(x(s.costParallelism))} of ${x(s.idealCostParallelism)} possible  ${dim("(each tx weighted by its estimated gas)")}`);
  out.push("");
  if (r.focus) {
    const f = r.focus;
    const fname = f.label?.name ?? shortAddr(f.address);
    out.push(bold(`  ${fname} (${f.address})`));
    if (f.txsTo === 0) out.push(dim("    no transaction used it in this range"));
    else {
      out.push(`    txs that used it      ${f.txsTo}, of which ${bold(pct(f.waitedTo / f.txsTo))} waited on an earlier tx`);
      if (f.blockedBy.length) {
        out.push(`    they waited on        ${f.blockedBy.slice(0, 5).map((b) => `${b.address === "sender" ? "their sender's earlier txs" : b.address === f.address ? "its own state" : b.label?.name ?? shortAddr(b.address)} ${b.waits}`).join(dim(" · "))}`);
      }
    }
    out.push(`    waits on its state    ${f.waitsOnItsState} across the range ${dim("(its slots and MON balance, any caller)")}`);
    out.push(`    if it were fixed      network ${x(s.effectiveParallelism)} → ${bold(x(f.parallelismIfFixed))}  ${dim(`gas-weighted ${x(s.costParallelism)} → ${x(f.costParallelismIfFixed)}`)}`);
    if (f.withPartner) {
      const p = f.withPartner;
      out.push(
        `    fixed together with ${p.label?.name ?? shortAddr(p.address)}: network ${x(s.effectiveParallelism)} → ${bold(x(p.parallelism))}  ${dim(`gas-weighted ${x(s.costParallelism)} → ${x(p.costParallelism)}; the same txs wait on both`)}`,
      );
    }
    out.push("");
  }
  out.push(`  what limits it  ${dim("(parallelism each kind of dependency would allow on its own)")}`);
  out.push(`    contract storage        ${x(s.storageParallelism).padEnd(8)} ${dim("shared slots: contract design")}`);
  out.push(`    shared MON balances     ${x(s.balanceParallelism).padEnd(8)} ${dim("many senders paying into one account: contract design")}`);
  out.push(`    same-sender order       ${x(s.nonceParallelism).padEnd(8)} ${dim("one sender's txs run in nonce order: not a contract issue")}`);
  out.push("");
  if (s.whatIf.length) {
    out.push(`  if the worst contracts were fixed  ${dim(`(from ${x(s.effectiveParallelism)}; their slots and MON balance stop conflicting, everything else stays)`)}`);
    for (const w of s.whatIf) {
      out.push(`    + ${(names.get(w.fixed) ?? shortAddr(w.fixed)).padEnd(28).slice(0, 28)} → ${x(w.effectiveParallelism).padEnd(8)} ${dim(`gas-weighted ${x(w.costParallelism)}`)}`);
    }
    out.push("");
  }
  if (r.pages) {
    const p = r.pages;
    out.push(`  if conflicts are tracked per MIP-8 page (128 slots) instead of per slot`);
    out.push(`    parallelism           ${x(p.summary.effectiveParallelism)}  ${dim(`(per slot: ${x(s.effectiveParallelism)})`)}`);
    out.push(`    false sharing         ${p.falseSharingEdges} of ${p.pageEdges} page-level waits ${dim("(different slots, same page)")}`);
    for (const f of p.falseSharing.slice(0, 5)) {
      const name = f.label?.name ?? shortAddr(f.address);
      out.push(`      ${String(f.waits).padStart(5)} waits  ${name.padEnd(28).slice(0, 28)} ${f.pageLabel}`);
    }
    out.push("");
  }
  if (r.contracts.length) {
    out.push(bold("  contracts whose state makes txs wait"));
    out.push(dim("  steps = sequential steps removed by fixing this contract alone (0 when it is hot together with another)"));
    for (const c of r.contracts.slice(0, 8)) {
      const name = c.label?.name ? `${c.label.name}${c.label.symbol ? ` (${c.label.symbol})` : ""}` : shortAddr(c.address);
      const viaBalance = c.balanceWaits ? dim(`  ${c.balanceWaits} via MON balance`) : "";
      out.push(`  ${String(c.stepsAdded).padStart(6)} steps  ${String(c.waits).padStart(6)} waits  ${String(c.keys).padStart(3)} hot slots  ${name}${viaBalance}`);
    }
    out.push("");
  }
  const hot = r.hotspots.slice(0, 12);
  if (hot.length) {
    out.push(bold("  hottest state and why it is hot"));
    const seen = new Set<string>();
    for (const h of hot) {
      const name = h.label?.name ? `${h.label.name}${h.label.symbol ? ` (${h.label.symbol})` : ""}` : shortAddr(h.address);
      let verdict = "";
      if (h.kind === "balance") {
        verdict = green(`${BALANCE_INFO.title} · fixable by design`);
        seen.add("balance");
      } else if (h.probe?.usage) {
        const u = h.probe.usage;
        verdict = AVOIDABLE.has(u) ? green(`${USAGE_INFO[u].title} · avoidable`) : `${USAGE_INFO[u].title} · inherent`;
        seen.add(u);
      } else if (h.probe) verdict = dim("unclassified");
      else if (BigInt(h.address) < 0x10000n) verdict = dim("system precompile, not replayed");
      else verdict = dim("not replayed");
      out.push(`  ${String(h.waits).padStart(6)} waits  ${name.padEnd(28).slice(0, 28)} ${h.slotLabel.padEnd(26).slice(0, 26)} ${verdict}`);
    }
    out.push("");
    if (seen.size) {
      out.push(bold("  how to fix"));
      for (const k of seen) {
        const info = k === "balance" ? BALANCE_INFO : USAGE_INFO[k as Usage];
        out.push(`    ${info.title}: ${dim(info.fix)}`);
      }
      out.push("");
    }
  }
  console.log(out.join("\n"));
}

const x = (v: number) => `${v.toFixed(2)}x`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
