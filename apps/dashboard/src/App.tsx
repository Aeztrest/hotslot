import { Fragment, useEffect, useState } from "react";
import { USAGE_INFO } from "@hotslot/core/explain";
import type { Report, ReportHotspot, BlockAnalysis, Usage } from "@hotslot/core/report";
import { BlockLines, DepGraph, HBars, Row } from "./charts.tsx";
import { contractName, explorerAddr, explorerTx, int, pct, shortAddr, shortHash, x } from "./format.ts";

export const SIMS = ["quest-naive", "quest-sharded", "quest-sharded-map", "quest-fixed", "pool"] as const;

async function load(name: string): Promise<Report | null> {
  const res = await fetch(`/${name}.json`);
  return res.ok ? ((await res.json()) as Report) : null;
}

/** `initial` lets the page be rendered with data already in hand (static export, screenshots). */
export function App({ initial }: { initial?: { net: Report | null; sims: Report[] } }) {
  const [net, setNet] = useState<Report | null | undefined>(initial?.net);
  const [sims, setSims] = useState<Report[]>(initial?.sims ?? []);
  useEffect(() => {
    if (initial) return;
    load("mainnet").then(setNet);
    Promise.all(SIMS.map((s) => load(`sim-${s}`))).then((r) => setSims(r.filter((x): x is Report => x !== null)));
  }, [initial]);

  if (net === undefined) return <main className="muted">loading…</main>;
  return (
    <main>
      <Hero net={net} />
      <WhyItHappens />
      {net && <Network r={net} />}
      {net && <BlockInspector r={net} />}
      {sims.length > 0 && <Simulations sims={sims} />}
      {(net?.pages || sims.some((s) => s.pages)) && <PageGranularity net={net ?? null} sims={sims} />}
      <Method />
      <footer>
        {net
          ? `hotslot · data from ${net.rpc}, blocks ${net.summary.firstBlock}–${net.summary.lastBlock}, generated ${net.generatedAt.slice(0, 16).replace("T", " ")} UTC`
          : "hotslot · no network scan yet: run pnpm hotslot scan"}
      </footer>
    </main>
  );
}

function Hero({ net }: { net: Report | null }) {
  const s = net?.summary;
  return (
    <header>
      <h1>hotslot</h1>
      {s ? (
        <p className="lede">
          {pct(s.conflictedShare)} of transactions on Monad mainnet had to wait for another transaction in the same block. Blocks use{" "}
          {pct(s.effectiveParallelism / s.idealParallelism)} of the parallelism they have.
        </p>
      ) : (
        <p className="lede">Find the storage slots that stop Monad from running transactions in parallel.</p>
      )}
      <p className="sub">
        Monad executes a block's transactions in parallel. Two transactions that touch the same storage slot cannot both run on the
        pre-block state, so one waits for the other. hotslot measures how much parallelism that costs, finds the contracts and slots
        responsible, and replays real transactions to tell which conflicts are avoidable.
      </p>
      {s && (
        <div className="tiles">
          <div className="tile">
            <div className="label">Parallelism available</div>
            <div className="value">{x(s.idealParallelism)}</div>
            <div className="foot">average transactions per block: what could run at once with no conflicts</div>
          </div>
          <div className="tile">
            <div className="label">Parallelism achieved</div>
            <div className="value">{x(s.effectiveParallelism)}</div>
            <div className="foot">Σ transactions ÷ Σ longest dependency chain, {int(s.blocks)} blocks</div>
          </div>
          <div className="tile">
            <div className="label">Transactions that waited</div>
            <div className="value">{pct(s.conflictedShare)}</div>
            <div className="foot">read a slot an earlier transaction in the block had written</div>
          </div>
          <div className="tile">
            <div className="label">Allowed by contract storage alone</div>
            <div className="value">{x(s.storageParallelism)}</div>
            <div className="foot">
              {s.whatIf.length > 0
                ? `${x(s.whatIf.at(-1)!.effectiveParallelism)} after fixing ${s.whatIf.length} contracts`
                : "the part contract design controls"}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function WhyItHappens() {
  return (
    <section>
      <h2>Why this happens</h2>
      <p className="intro">
        It is not a bug in Monad, and it is not careless developers. It is what happens when contracts written for a sequential chain
        run on a parallel one that, by design, never tells them.
      </p>
      <div className="steps">
        <div className="step">
          <b>1. Optimistic execution</b>
          <p>Monad runs every transaction in a block at the same time, each against the state at the start of the block, then commits results in block order.</p>
        </div>
        <div className="step">
          <b>2. A shared slot creates a wait</b>
          <p>If tx 7 read a slot that tx 3 wrote, tx 7 ran on a stale value. Its result is thrown away and it re-executes after tx 3. It cannot finish before tx 3.</p>
        </div>
        <div className="step">
          <b>3. The longest chain sets the pace</b>
          <p>With unlimited cores, a block still needs as many sequential steps as its longest chain of such waits. One <code>totalCount += 1</code> that every user hits turns the block into a single chain.</p>
        </div>
        <div className="step">
          <b>4. Nobody sees it</b>
          <p>Ethereum is sequential, so a global counter costs nothing there. Monad keeps full EVM compatibility, so there is no error, no extra gas and no warning. Solana makes you declare accounts up front; Monad hides the conflict.</p>
        </div>
      </div>
    </section>
  );
}

function Network({ r }: { r: Report }) {
  const s = r.summary;
  const names = new Map(r.contracts.map((c) => [c.address, contractName(c.address, c.label)]));
  const base = { key: "now", label: <span className="secondary">storage conflicts today</span>, value: s.storageParallelism, valueLabel: x(s.storageParallelism), muted: true };
  const kinds = [
    { key: "all", label: <span>all dependencies</span>, value: s.effectiveParallelism, valueLabel: x(s.effectiveParallelism), tip: <Row k="what blocks achieve" v={x(s.effectiveParallelism)} /> },
    { key: "storage", label: <span>contract storage only</span>, value: s.storageParallelism, valueLabel: x(s.storageParallelism), tip: <Row k="if only storage conflicts existed" v={x(s.storageParallelism)} /> },
    { key: "account", label: <span>same-account only</span>, value: s.accountParallelism, valueLabel: x(s.accountParallelism), muted: true, tip: <Row k="if only nonce/balance order existed" v={x(s.accountParallelism)} /> },
    { key: "ideal", label: <span className="secondary">no dependencies</span>, value: s.idealParallelism, valueLabel: x(s.idealParallelism), muted: true },
  ];
  const steps = s.whatIf.map((w, i) => ({
    key: w.fixed,
    label: <span>{i === 0 ? "fix " : "+ "}{names.get(w.fixed) ?? shortAddr(w.fixed)}</span>,
    value: w.effectiveParallelism,
    valueLabel: x(w.effectiveParallelism),
    tip: (
      <>
        <div className="t">{names.get(w.fixed) ?? w.fixed}</div>
        <Row k="storage parallelism after this fix" v={x(w.effectiveParallelism)} />
        <Row k="total sequential steps" v={int(w.totalPath)} />
      </>
    ),
  }));
  const ideal = { key: "ideal", label: <span className="secondary">no storage conflicts at all</span>, value: s.idealParallelism, valueLabel: x(s.idealParallelism), muted: true };

  return (
    <section>
      <h2>Monad mainnet, {int(s.blocks)} blocks</h2>
      <p className="intro">
        {int(s.txs)} transactions, blocks {int(s.firstBlock)}–{int(s.lastBlock)}. For every block we trace what each transaction read and
        wrote, link each read to the last earlier transaction that wrote the same slot, and measure the longest chain.
      </p>
      <div className="card">
        <h3>Every block, side by side</h3>
        <p className="note">The space between the lines is parallelism the block had and could not use. Hover for a block.</p>
        <BlockLines
          rows={r.blocks}
          tooltip={(i) => {
            const b = r.blocks[i];
            return (
              <>
                <div className="t">block {int(b.number)}</div>
                <Row k="transactions" v={b.txCount} />
                <Row k="longest chain" v={b.pathLength} />
                <Row k="parallelism" v={x(b.txCount / b.pathLength)} />
                <Row k="waited" v={`${b.conflictedTxs} of ${b.txCount}`} />
              </>
            );
          }}
        />
      </div>
      <div className="card">
        <h3>Two kinds of waits</h3>
        <p className="note">
          Parallelism each kind of dependency would allow on its own. Same-account waits are one sender submitting several transactions in a
          block (bots, relayers): they run in nonce order by definition and no contract change removes them. Storage waits are the part
          contract design controls, and they are the bigger limit.
        </p>
        <HBars items={kinds} />
      </div>
      <div className="card">
        <h3>What fixing a few contracts would do</h3>
        <p className="note">
          Storage-only parallelism recomputed on the same blocks with each contract's conflicts removed, one contract at a time, always
          picking the fix that helps most next. Contracts are often hot together, so the order matters. This is an upper bound: it removes every conflict on the contract's storage, including ones the replay classifies as inherent.
        </p>
        <HBars items={[base, ...steps, ideal]} />
      </div>
      <ContractTable r={r} />
    </section>
  );
}

function usageSummary(slots: ReportHotspot[]): Partial<Record<Usage, number>> {
  const out: Partial<Record<Usage, number>> = {};
  for (const h of slots) if (h.probe?.usage) out[h.probe.usage] = (out[h.probe.usage] ?? 0) + 1;
  return out;
}

function UsageBadge({ usage }: { usage: Usage | null | undefined }) {
  if (!usage) return <span className="badge none">not replayed</span>;
  const info = USAGE_INFO[usage];
  return (
    <span className={`badge ${info.avoidable ? "avoidable" : "inherent"}`} title={info.why}>
      {info.title} · {info.avoidable ? "avoidable" : "inherent"}
    </span>
  );
}

function ContractTable({ r }: { r: Report }) {
  const [open, setOpen] = useState<string | null>(r.contracts[0]?.address ?? null);
  const slotsOf = (a: string) => r.hotspots.filter((h) => h.address === a);
  return (
    <div className="card">
      <h3>Contracts whose storage makes transactions wait</h3>
      <p className="note">
        Root cause comes from replaying sampled transactions at their exact position in the block with only the hot slot's value changed,
        then comparing every write, transfer, log and the revert status. Click a contract for its slots.
      </p>
      <table>
        <thead>
          <tr>
            <th>contract</th>
            <th className="num">waits</th>
            <th className="num">hot slots</th>
            <th className="num">steps if fixed alone</th>
            <th>replayed slots</th>
          </tr>
        </thead>
        <tbody>
          {r.contracts.slice(0, 10).map((c) => {
            const slots = slotsOf(c.address);
            const sum = usageSummary(slots);
            const isOpen = open === c.address;
            const link = explorerAddr(r.chainId, c.address);
            return (
              <Fragment key={c.address}>
                <tr onClick={() => setOpen(isOpen ? null : c.address)} style={{ cursor: "pointer" }}>
                  <td>
                    {isOpen ? "▾ " : "▸ "}
                    {contractName(c.address, c.label)}
                    <div className="mono muted">{link ? <a href={link} target="_blank" rel="noreferrer" className="muted" onClick={(e) => e.stopPropagation()}>{c.address}</a> : c.address}</div>
                  </td>
                  <td className="num">{int(c.waits)}</td>
                  <td className="num">{c.keys}</td>
                  <td className="num">{int(c.stepsAdded)}</td>
                  <td>
                    {Object.entries(sum).length === 0 ? (
                      <span className="muted">{BigInt(c.address) < 0x10000n ? "Monad system precompile" : "—"}</span>
                    ) : (
                      Object.entries(sum).map(([u, n]) => (
                        <div key={u}>
                          <UsageBadge usage={u as Usage} /> <span className="muted">×{n}</span>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={5} style={{ paddingLeft: 18 }}>
                      <SlotTable r={r} slots={slots} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SlotTable({ r, slots }: { r: Report; slots: ReportHotspot[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>slot</th>
          <th className="num">waits</th>
          <th>how transactions use it</th>
          <th>evidence</th>
        </tr>
      </thead>
      <tbody>
        {slots.map((h) => (
          <tr key={h.key}>
            <td className="mono">{h.slotLabel}</td>
            <td className="num">{int(h.waits)}</td>
            <td>
              <UsageBadge usage={h.probe?.usage} />
              {h.probe?.usage && <div className="muted" style={{ fontSize: 12.5, maxWidth: 380 }}>{USAGE_INFO[h.probe.usage].fix}</div>}
            </td>
            <td className="mono">
              {h.probe?.results.map((p) => {
                const link = explorerTx(r.chainId, p.hash);
                return (
                  <div key={p.hash} title={p.skipped ?? (p.affectedKeys ? `changed: ${p.affectedKeys.join(", ")}` : "")}>
                    {link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(p.hash)}</a> : shortHash(p.hash)}{" "}
                    <span className="muted">{p.usage ?? p.skipped}</span>
                  </div>
                );
              })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GraphCard({ r, b, title, note }: { r: Report; b: BlockAnalysis; title: string; note?: string }) {
  const names = new Map([...r.contracts, ...r.hotspots].map((c) => [c.address, contractName(c.address, c.label)]));
  const slotNames = new Map(r.hotspots.map((h) => [h.key, `${names.get(h.address) ?? shortAddr(h.address)} · ${h.slotLabel}`]));
  const keyName = (k: string) => {
    const [a, s] = k.split(":");
    return slotNames.get(k) ?? `${names.get(a) ?? shortAddr(a)} · ${s.startsWith("0x") ? `slot ${s.slice(0, 8)}…` : s}`;
  };
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="note">
        {note ?? ""} {b.txCount} transactions, longest chain {b.pathLength} → parallelism {x(b.txCount / b.pathLength)}. Each dot is a transaction
        in block order, raised one row above the transaction it waited for. Orange is the critical path.
      </p>
      <DepGraph
        n={b.txCount}
        edges={b.edges}
        critical={b.criticalPath}
        nodeTip={(i, depth) => {
          const t = b.txs[i];
          const incoming = b.edges.filter((e) => e.to === i);
          return (
            <>
              <div className="t">tx {i} {t.system && <span className="muted">(system)</span>}</div>
              <Row k="calls" v={t.to ? names.get(t.to) ?? shortAddr(t.to) : "create"} />
              <Row k="chain depth" v={depth} />
              {incoming.length > 0 && <div className="muted" style={{ marginTop: 4 }}>waited on</div>}
              {incoming.slice(0, 4).map((e) => (
                <div key={e.from} style={{ fontSize: 12 }}>
                  tx {e.from}: {e.keys.slice(0, 2).map(keyName).join(", ")}
                  {e.keys.length > 2 && <span className="muted"> +{e.keys.length - 2} more</span>}
                </div>
              ))}
              <div className="mono muted" style={{ marginTop: 4 }}>{shortHash(t.hash)}</div>
            </>
          );
        }}
      />
    </div>
  );
}

function BlockInspector({ r }: { r: Report }) {
  const [i, setI] = useState(0);
  const b = r.showcase[i];
  if (!b) return null;
  return (
    <section>
      <h2>Inside a block</h2>
      <p className="intro">The busiest blocks in the range. A block that ran fully parallel would be a flat line along the bottom.</p>
      <div className="tabs">
        {r.showcase.map((s, k) => (
          <button key={s.number} aria-pressed={k === i} onClick={() => setI(k)}>
            {int(s.number)} · {s.txCount} txs
          </button>
        ))}
      </div>
      <GraphCard r={r} b={b} title={`Block ${int(b.number)}`} />
    </section>
  );
}

function Simulations({ sims }: { sims: Report[] }) {
  const [i, setI] = useState(0);
  const sel = sims[i];
  return (
    <section>
      <h2>Before you deploy</h2>
      <p className="intro">
        <code>hotslot simulate</code> deploys a contract on a local chain, has N different users call it in the same block, and runs the
        same analysis, with slot names from the Solidity storage layout. Same app, four storage designs, plus a pool where the conflict
        is real.
      </p>
      <div className="card">
        <h3>{sel.scenario?.users ?? 64} users in one block</h3>
        <p className="note">Parallelism of the simulated block. Gray: the conflict is inherent to the logic.</p>
        <HBars
          max={Math.max(...sims.map((s) => s.summary.idealParallelism))}
          items={sims.map((s) => {
            const inherent = s.hotspots.some((h) => h.probe?.usage && !USAGE_INFO[h.probe.usage].avoidable);
            return {
              key: s.title,
              label: <span>{s.scenario?.contract}</span>,
              value: s.summary.effectiveParallelism,
              valueLabel: x(s.summary.effectiveParallelism),
              muted: inherent,
              tip: (
                <>
                  <div className="t">{s.scenario?.contract}</div>
                  <div className="muted" style={{ marginBottom: 4 }}>{s.scenario?.description}</div>
                  <Row k="parallelism" v={x(s.summary.effectiveParallelism)} />
                  <Row k="txs that waited" v={pct(s.summary.conflictedShare)} />
                </>
              ),
            };
          })}
        />
      </div>
      <div className="tabs" style={{ marginTop: 16 }}>
        {sims.map((s, k) => (
          <button key={s.title} aria-pressed={k === i} onClick={() => setI(k)}>
            {s.scenario?.contract}
          </button>
        ))}
      </div>
      <GraphCard r={sel} b={sel.showcase[0]} title={sel.title} note={sel.scenario?.description} />
      {sel.hotspots.length > 0 && (
        <div className="card">
          <h3>Hot slots in {sel.scenario?.contract}</h3>
          <SlotTable r={sel} slots={sel.hotspots.slice(0, 8)} />
        </div>
      )}
    </section>
  );
}

function PageGranularity({ net, sims }: { net: Report | null; sims: Report[] }) {
  const p = net?.pages;
  return (
    <section>
      <h2>Per slot or per page? (MIP-8)</h2>
      <p className="intro">
        <a href="https://mips.monad.xyz/MIPs/MIP-8" target="_blank" rel="noreferrer">MIP-8</a> groups storage into pages of 128 consecutive
        slots: the unit of disk I/O, of the state commitment and of SLOAD/SSTORE gas. It does not say whether parallel execution detects
        conflicts per slot or per page. If it is per page, two transactions writing <i>different</i> slots on the same page still wait for
        each other. That is false sharing, the same thing that happens when two CPU cores write different variables on one cache line.
        Everything above is per slot; this section reruns it per page.
      </p>
      {p && net && (
        <div className="card">
          <h3>Mainnet, same {int(net.summary.blocks)} blocks</h3>
          <p className="note">
            {int(p.falseSharingEdges)} of {int(p.pageEdges)} page-level waits ({pct(p.pageEdges ? p.falseSharingEdges / p.pageEdges : 0)}) exist
            only at page granularity: the two transactions touched different slots that share a page. On today's mainnet the difference is small: the hot contracts already collide on the same slots. Where granularity decides the outcome is contract design, below.
          </p>
          <HBars
            max={net.summary.idealParallelism}
            items={[
              { key: "slot", label: <span>conflicts per slot</span>, value: net.summary.effectiveParallelism, valueLabel: x(net.summary.effectiveParallelism) },
              { key: "page", label: <span>conflicts per page</span>, value: p.summary.effectiveParallelism, valueLabel: x(p.summary.effectiveParallelism) },
            ]}
          />
          {p.falseSharing.length > 0 && (
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>contract</th>
                  <th>page</th>
                  <th className="num">false-sharing waits</th>
                  <th className="num">blocks</th>
                </tr>
              </thead>
              <tbody>
                {p.falseSharing.slice(0, 8).map((f) => (
                  <tr key={f.key}>
                    <td>{contractName(f.address, f.label)}</td>
                    <td className="mono">{f.pageLabel}</td>
                    <td className="num">{int(f.waits)}</td>
                    <td className="num">{int(f.blocks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {sims.some((s) => s.pages) && (
        <div className="card">
          <h3>The simulated contracts at both granularities</h3>
          <p className="note">
            QuestSharded keeps its 64 shards in a <code>uint256[64]</code>: 64 consecutive slots, all on page 0. Per slot it reaches 21×; per
            page every shard collides and it is back to 1×. QuestShardedMap keeps the same shards in a mapping, whose entries are hashed onto
            different pages, and holds 21× either way.
          </p>
          <table>
            <thead>
              <tr>
                <th>contract</th>
                <th className="num">per slot</th>
                <th className="num">per page</th>
                <th>false sharing</th>
              </tr>
            </thead>
            <tbody>
              {sims.map((s) => (
                <tr key={s.title}>
                  <td>{s.scenario?.contract}</td>
                  <td className="num">{x(s.summary.effectiveParallelism)}</td>
                  <td className="num">{s.pages ? x(s.pages.summary.effectiveParallelism) : "—"}</td>
                  <td className="mono">
                    {s.pages?.falseSharing[0] ? `${s.pages.falseSharingEdges} waits · ${s.pages.falseSharing[0].pageLabel}` : <span className="muted">none</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 14, marginBottom: 0 }}>
            The design advice that holds at both granularities: shard with mappings, not arrays or adjacent variables. MIP-8's gas model
            pulls the other way: later slots on an already-touched page are warm and cheap, so packing hot data onto one page saves gas while
            concentrating conflicts.
          </p>
        </div>
      )}
    </section>
  );
}

function Method() {
  return (
    <section>
      <h2>How it is measured, and what it does not claim</h2>
      <div className="card">
        <ul className="limits">
          <li>
            <b>Reads and writes</b> come from <code>debug_traceBlockByNumber</code> with geth's <code>prestateTracer</code>, once in default mode
            (everything touched) and once in diff mode (what changed). An SSTORE counts as a read: its gas cost depends on the current value.
            Writes of an unchanged value do not count.
          </li>
          <li>
            <b>Parallelism</b> is Σ transactions ÷ Σ longest dependency chain: the speedup unlimited cores could get if every transaction cost
            the same. Real speedup also depends on core count, transaction cost and I/O. This is an upper bound on what the block's data
            dependencies allow, not a measurement of Monad's executor.
          </li>
          <li>
            <b>Root cause</b> replays a transaction with <code>debug_traceCall</code> on the including block, with every write made by that
            transaction and later ones rewound through state overrides, so it sees exactly the state it saw on chain. A replay is only used if
            it reproduces the transaction's on-chain storage writes exactly. Then the hot slot's value is changed and the effects are diffed.
          </li>
          <li>
            <b>Balance conflicts</b> are only counted when both transactions change the balance; a plain BALANCE read is not visible to the
            tracer, so account-level conflicts are under-counted rather than invented.
          </li>
          <li>
            <b>Monad system transactions</b> (gas = 0) and the staking precompile are part of the graph, since they execute in the block, but
            they are not replayed.
          </li>
        </ul>
      </div>
    </section>
  );
}
