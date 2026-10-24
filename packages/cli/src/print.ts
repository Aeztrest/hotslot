import { AVOIDABLE, USAGE_INFO, shortAddr, type Report } from "@hotslot/core";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export function printReport(r: Report): void {
  const s = r.summary;
  const out: string[] = [];
  out.push("");
  out.push(bold(r.title));
  out.push(dim(`blocks ${s.firstBlock}–${s.lastBlock} · ${s.blocks} blocks · ${s.txs} txs · chain ${r.chainId}`));
  out.push("");
  out.push(`  conflicted txs        ${pct(s.conflictedShare)} had to wait on an earlier tx in the same block`);
  out.push(`  parallelism possible  ${x(s.idealParallelism)}  ${dim("(no conflicts: every tx runs at once)")}`);
  out.push(`  parallelism actual    ${bold(x(s.effectiveParallelism))}  ${dim("(Σ txs / Σ longest dependency chain)")}`);
  out.push(`  lost                  ${red(pct(1 - s.effectiveParallelism / s.idealParallelism))} of the available parallelism`);
  out.push("");
  out.push("  limited by:");
  out.push(`    contract storage only     ${x(s.storageParallelism)}  ${dim("(what contract design controls)")}`);
  out.push(`    same-account txs only     ${x(s.accountParallelism)}  ${dim("(one sender's txs run in nonce order; nothing to fix)")}`);
  out.push("");
  out.push(`  storage parallelism as contracts are fixed (from ${x(s.storageParallelism)}, each step picks the fix that helps most):`);
  const names = new Map(r.contracts.map((c) => [c.address, c.label?.name ?? shortAddr(c.address)]));
  for (const w of s.whatIf) out.push(`    + ${(names.get(w.fixed) ?? shortAddr(w.fixed)).padEnd(28)} → ${x(w.effectiveParallelism)}`);
  out.push("");
  if (r.pages) {
    const p = r.pages;
    out.push(bold("  if conflicts are tracked per MIP-8 page (128 slots) instead of per slot"));
    out.push(`    parallelism actual    ${x(p.summary.effectiveParallelism)}  ${dim(`(per slot: ${x(s.effectiveParallelism)})`)}`);
    out.push(`    storage only          ${x(p.summary.storageParallelism)}  ${dim(`(per slot: ${x(s.storageParallelism)})`)}`);
    out.push(`    false sharing         ${p.falseSharingEdges} of ${p.pageEdges} page-level waits ${dim("(different slots, same page)")}`);
    for (const f of p.falseSharing.slice(0, 5)) {
      const name = f.label?.name ?? shortAddr(f.address);
      out.push(`      ${String(f.waits).padStart(5)} waits  ${name.padEnd(28).slice(0, 28)} ${f.pageLabel}`);
    }
    out.push("");
  }
  out.push(bold("  contracts whose storage makes txs wait"));
  out.push(dim("  steps = critical-path steps removed by fixing this contract alone (0 when it is hot together with another)"));
  out.push("");
  for (const c of r.contracts.slice(0, 8)) {
    const name = c.label?.name ? `${c.label.name}${c.label.symbol ? ` (${c.label.symbol})` : ""}` : shortAddr(c.address);
    out.push(`  ${String(c.stepsAdded).padStart(5)} steps  ${String(c.waits).padStart(5)} waits  ${String(c.keys).padStart(3)} hot slots  ${name}`);
  }
  out.push("");
  out.push(bold("  hottest storage slots and why they are hot"));
  out.push("");
  for (const h of r.hotspots.slice(0, 12)) {
    const name = h.label?.name ? `${h.label.name}${h.label.symbol ? ` (${h.label.symbol})` : ""}` : shortAddr(h.address);
    const usage = h.probe?.usage;
    const verdict = usage ? (AVOIDABLE.has(usage) ? green(`${USAGE_INFO[usage].title} · avoidable`) : `${USAGE_INFO[usage].title} · inherent`) : dim(h.probe ? "unclassified" : "");
    out.push(`  ${String(h.waits).padStart(5)} waits  ${name.padEnd(28).slice(0, 28)} ${h.slotLabel.padEnd(24).slice(0, 24)} ${verdict}`);
  }
  out.push("");
  console.log(out.join("\n"));
}

const x = (v: number) => `${v.toFixed(2)}x`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
