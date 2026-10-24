import { useMemo, useRef, useState, type ReactNode } from "react";

/** Tooltip positioned inside a `.chart` container, kept on-screen horizontally. */
function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x > width * 0.65 ? undefined : x + 14;
  const right = x > width * 0.65 ? width - x + 14 : undefined;
  return (
    <div className="tooltip" style={{ left, right, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

export function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Per-block line chart: transactions in the block vs. the longest dependency chain.
 * The gap between the two lines is the parallelism the block could not use.
 */
export function BlockLines({
  rows,
  tooltip,
}: {
  rows: { number: number; txCount: number; pathLength: number }[];
  tooltip: (i: number) => ReactNode;
}) {
  const W = 1000, H = 260, L = 34, R = 8, T = 10, B = 26;
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...rows.map((r) => r.txCount)));
  const sx = (i: number) => L + (i / Math.max(1, rows.length - 1)) * (W - L - R);
  const sy = (v: number) => T + (1 - v / max) * (H - T - B);
  const path = (f: (r: (typeof rows)[number]) => number) => rows.map((r, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(f(r)).toFixed(1)}`).join("");
  const ticks = [0, max / 2, max];

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((vx - L) / (W - L - R)) * (rows.length - 1));
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const width = ref.current?.getBoundingClientRect().width ?? W;
  const scale = width / W;

  return (
    <div className="chart" ref={ref} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <div className="legend">
        <span style={{ ["--c" as string]: "var(--series-1)" }}><i />transactions in block (what full parallelism could run at once)</span>
        <span style={{ ["--c" as string]: "var(--series-2)" }}><i />longest dependency chain (steps the block actually needs)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Transactions per block versus longest dependency chain">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
            <text x={L - 6} y={sy(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        <text x={L} y={H - 6}>block {rows[0]?.number}</text>
        <text x={W - R} y={H - 6} textAnchor="end">block {rows.at(-1)?.number}</text>
        <path d={path((r) => r.txCount)} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        <path d={path((r) => r.pathLength)} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && (
          <g>
            <line x1={sx(hover)} x2={sx(hover)} y1={T} y2={H - B} stroke="var(--text-muted)" strokeDasharray="3 3" />
            <circle cx={sx(hover)} cy={sy(rows[hover].txCount)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
            <circle cx={sx(hover)} cy={sy(rows[hover].pathLength)} r={4} fill="var(--series-2)" stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={sx(hover) * scale} y={sy(rows[hover].txCount) * scale} width={width}>
          {tooltip(hover)}
        </Tooltip>
      )}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  valueLabel: string;
  muted?: boolean;
  tip?: ReactNode;
}

/** Horizontal bars, one series, value labelled at the end of each bar. */
export function HBars({ items, max }: { items: BarItem[]; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const top = max ?? Math.max(...items.map((i) => i.value));
  const rowH = 30;
  const W = 1000, labelW = 300, valueW = 70;
  const sw = (v: number) => Math.max(2, (v / top) * (W - labelW - valueW));
  const width = ref.current?.getBoundingClientRect().width ?? W;
  const scale = width / W;
  return (
    <div className="chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${items.length * rowH}`} role="img">
        {items.map((it, i) => (
          <g key={it.key} onPointerEnter={() => setHover(i)}>
            <rect x={0} y={i * rowH} width={W} height={rowH} fill="transparent" />
            <foreignObject x={0} y={i * rowH} width={labelW - 12} height={rowH}>
              <div style={{ fontSize: 13, lineHeight: `${rowH}px`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</div>
            </foreignObject>
            <path
              d={roundedBar(labelW, i * rowH + 8, sw(it.value), rowH - 16)}
              fill={it.muted ? "var(--neutral-mark)" : "var(--series-1)"}
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
            <text x={labelW + sw(it.value) + 8} y={i * rowH + rowH / 2 + 4} className="label-strong">{it.valueLabel}</text>
          </g>
        ))}
      </svg>
      {hover !== null && items[hover].tip && (
        <Tooltip x={(labelW + sw(items[hover].value)) * scale} y={(hover * rowH + rowH) * scale} width={width}>
          {items[hover].tip}
        </Tooltip>
      )}
    </div>
  );
}

/** Bar anchored at the baseline (square left end), 4px rounded data end. */
function roundedBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/**
 * Dependency graph laid out so its *height* is the block's sequential cost:
 * x = position in the block, y = how many txs deep its dependency chain is.
 * A fully parallel block is a flat line; a fully serialized one is a staircase.
 */
export function DepGraph({
  n,
  edges,
  critical,
  nodeTip,
}: {
  n: number;
  edges: { from: number; to: number }[];
  critical: number[];
  nodeTip: (i: number, depth: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const depth = useMemo(() => {
    const d = new Array<number>(n).fill(1);
    for (const e of [...edges].sort((a, b) => a.to - b.to)) d[e.to] = Math.max(d[e.to], d[e.from] + 1);
    return d;
  }, [n, edges]);
  const maxDepth = Math.max(1, ...depth);
  const W = 1000, L = 40, R = 12, T = 12, B = 22;
  const rowH = Math.max(3, Math.min(26, 280 / maxDepth));
  const H = T + B + (maxDepth - 1) * rowH + 10;
  const sx = (i: number) => L + (n <= 1 ? 0.5 : i / (n - 1)) * (W - L - R);
  const sy = (dep: number) => H - B - (dep - 1) * rowH;
  const onPath = new Set(critical);
  const pathEdges = new Set(critical.slice(1).map((t, k) => `${critical[k]}-${t}`));
  const width = ref.current?.getBoundingClientRect().width ?? W;
  const scale = width / W;
  const r = n > 80 ? 3.5 : 4.5;

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Dependency graph: ${n} transactions, longest chain ${maxDepth}`}>
        <line x1={L} x2={W - R} y1={sy(1)} y2={sy(1)} stroke="var(--grid)" />
        <text x={L - 8} y={sy(1) + 4} textAnchor="end">1</text>
        {maxDepth > 1 && (
          <>
            <line x1={L} x2={W - R} y1={sy(maxDepth)} y2={sy(maxDepth)} stroke="var(--grid)" />
            <text x={L - 8} y={sy(maxDepth) + 4} textAnchor="end">{maxDepth}</text>
          </>
        )}
        <text x={L} y={H - 4}>tx 0</text>
        <text x={W - R} y={H - 4} textAnchor="end">tx {n - 1} · position in block →</text>
        {edges.map((e) => {
          const crit = pathEdges.has(`${e.from}-${e.to}`);
          const near = hover !== null && (e.from === hover || e.to === hover);
          return (
            <line
              key={`${e.from}-${e.to}`}
              x1={sx(e.from)} y1={sy(depth[e.from])} x2={sx(e.to)} y2={sy(depth[e.to])}
              stroke={crit ? "var(--series-2)" : near ? "var(--text-secondary)" : "var(--neutral-mark)"}
              strokeWidth={crit || near ? 1.6 : 1}
              opacity={crit || near ? 1 : 0.6}
            />
          );
        })}
        {depth.map((d, i) => (
          <g key={i} onPointerEnter={() => setHover(i)}>
            <circle cx={sx(i)} cy={sy(d)} r={10} fill="transparent" />
            <circle
              cx={sx(i)} cy={sy(d)} r={hover === i ? r + 1.5 : r}
              fill={onPath.has(i) ? "var(--series-2)" : "var(--series-1)"}
              stroke="var(--surface-1)" strokeWidth={1.5}
            />
          </g>
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={sx(hover) * scale} y={sy(depth[hover]) * scale + 14} width={width}>
          {nodeTip(hover, depth[hover])}
        </Tooltip>
      )}
    </div>
  );
}
