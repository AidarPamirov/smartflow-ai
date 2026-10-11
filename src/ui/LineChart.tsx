import { useMemo, useRef, useState } from 'react';

export interface Series {
  name: string;
  color: string; // CSS-переменная или цвет
  points: { x: number; y: number | null }[];
}

interface Props {
  title: string;
  unit: string;
  series: Series[];
  empty: string;
  format?: (y: number) => string;
}

const W = 520, H = 200, M = { l: 40, r: 12, t: 12, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Простой линейный график на SVG с перекрестьем и подсказкой. Без внешних библиотек. */
export function LineChart({ title, unit, series, empty, format = (y) => y.toFixed(1) }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  const hasData = series.some((s) => s.points.some((p) => p.y !== null));

  const { xMax, yMax, paths } = useMemo(() => {
    const xMax = Math.max(1, ...xs);
    const yMax = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y ?? 0))));
    const sx = (x: number) => M.l + (x / xMax) * (W - M.l - M.r);
    const sy = (y: number) => H - M.b - (y / yMax) * (H - M.t - M.b);
    const paths = series.map((s) => {
      let d = '', pen = false;
      for (const p of s.points) {
        if (p.y === null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
        pen = true;
      }
      return d;
    });
    return { xMax, yMax, paths };
  }, [series, xs]);

  const sx = (x: number) => M.l + (x / xMax) * (W - M.l - M.r);
  const sy = (y: number) => H - M.b - (y / yMax) * (H - M.t - M.b);

  const onMove = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg || xs.length === 0) return;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const t = ((x - M.l) / (W - M.l - M.r)) * xMax;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    setHover(best);
  };

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.name} className="legend-item">
                <i style={{ background: s.color }} />{s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      {!hasData ? (
        <div className="empty">{empty}</div>
      ) : (
        <div className="chart-body">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={M.l} x2={W - M.r} y1={sy(yMax * f)} y2={sy(yMax * f)} className="grid" />
                <text x={M.l - 6} y={sy(yMax * f)} className="tick" textAnchor="end" dominantBaseline="middle">
                  {Number.isInteger(yMax * f) ? yMax * f : (yMax * f).toFixed(1)}
                </text>
              </g>
            ))}
            <text x={M.l} y={H - 6} className="tick">0 с</text>
            <text x={W - M.r} y={H - 6} className="tick" textAnchor="end">{Math.round(xMax)} с</text>
            {paths.map((d, i) => (
              <path key={series[i].name} d={d} fill="none" stroke={series[i].color} strokeWidth={2} strokeLinejoin="round" />
            ))}
            {hover !== null && (
              <g>
                <line x1={sx(xs[hover])} x2={sx(xs[hover])} y1={M.t} y2={H - M.b} className="crosshair" />
                {series.map((s) => {
                  const y = s.points[hover]?.y;
                  return y == null ? null : <circle key={s.name} cx={sx(xs[hover])} cy={sy(y)} r={4} fill={s.color} className="dot" />;
                })}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: `${(sx(xs[hover]) / W) * 100}%` }}>
              <div className="tooltip-t">t = {xs[hover]} с</div>
              {series.map((s) => {
                const y = s.points[hover]?.y;
                return (
                  <div key={s.name}>
                    <i style={{ background: s.color }} />{s.name}: <b>{y == null ? '—' : `${format(y)} ${unit}`}</b>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
