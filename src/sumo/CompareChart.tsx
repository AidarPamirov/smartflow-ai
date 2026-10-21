import { useState } from 'react';
import type { Stat } from './trace';

export interface Series { key: string; label: string; color: string }
export interface Metric {
  id: string; label: string; unit: string; digits: number; lowerBetter: boolean; get: (load: string, series: string) => Stat | undefined;
  /** Свои группы по оси X (например, только стресс-сценарий); по умолчанию — общие. */
  loads?: string[];
}

const LOAD_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая', incident: 'ДТП на выезде' };
const nf = (x: number, d: number) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Сгруппированные столбцы: нагрузки по оси X, способы управления — столбцы с разбросом между seed (± ст. откл.).
 * Метрика выбирается переключателем. Одна ось Y, цвет закреплён за способом управления.
 */
export function CompareChart({ title, loads: allLoads, series, metrics }: { title: string; loads: string[]; series: Series[]; metrics: Metric[] }) {
  const [mid, setMid] = useState(metrics[0].id);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const m = metrics.find((x) => x.id === mid) ?? metrics[0];
  const loads = m.loads ?? allLoads;
  const vals = loads.map((l) => series.map((s) => m.get(l, s.key)));
  const top = Math.max(1e-9, ...vals.flat().map((v) => (v && v[0] != null ? v[0] + (v[1] ?? 0) : 0)));
  const nice = niceMax(top);
  const W = 640, H = 260, L = 46, R = 10, T = 22, B = 34;
  const gw = (W - L - R) / loads.length;
  const bw = Math.min(24, (gw * 0.7) / series.length);
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => k * nice);
  return (
    <figure className="cmp">
      <figcaption className="cmp-head">
        <b>{title}</b>
        <div className="seg cmp-seg" role="group" aria-label="Метрика">
          {metrics.map((x) => <button key={x.id} className={x.id === m.id ? 'on' : ''} onClick={() => setMid(x.id)}>{x.label}</button>)}
        </div>
      </figcaption>
      <div className="cmp-legend">
        {series.map((s) => <span key={s.key} className="legend-item"><i style={{ background: s.color }} />{s.label}</span>)}
        <span className="muted small">{m.lowerBetter ? 'меньше — лучше' : 'больше — лучше'}, {m.unit}</span>
      </div>
      <div className="cmp-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${m.label}`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="cmp-grid" />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="cmp-tick">{nf(v, nice < 10 ? 1 : 0)}</text>
            </g>
          ))}
          {loads.map((l, i) => {
            const x0 = L + gw * i + (gw - bw * series.length - 2 * (series.length - 1)) / 2;
            return (
              <g key={l}>
                {series.map((s, j) => {
                  const v = vals[i][j];
                  if (!v || v[0] == null) return null;
                  const x = x0 + j * (bw + 2), h = Math.max(1, y(0) - y(v[0]));
                  const sd = v[1] ?? 0;
                  const text = `${LOAD_LABEL[l] ?? l} · ${s.label}: ${nf(v[0], m.digits)}${sd ? ` ± ${nf(sd, m.digits)}` : ''} ${m.unit}`;
                  return (
                    <g key={s.key} onMouseMove={(e) => setHover({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, text })}>
                      <rect x={x - 3} y={T} width={bw + 6} height={H - T - B} fill="transparent" />
                      <path d={bar(x, y(0), bw, h)} fill={s.color} />
                      {sd > 0 && (
                        <g className="cmp-err">
                          <line x1={x + bw / 2} x2={x + bw / 2} y1={y(v[0] + sd)} y2={y(Math.max(0, v[0] - sd))} />
                          <line x1={x + bw / 2 - 4} x2={x + bw / 2 + 4} y1={y(v[0] + sd)} y2={y(v[0] + sd)} />
                        </g>
                      )}
                      <text x={x + bw / 2} y={y(v[0] + sd) - 5} textAnchor="middle" className="cmp-val">{nf(v[0], m.digits === 0 ? 0 : v[0] >= 100 ? 0 : 1)}</text>
                    </g>
                  );
                })}
                <text x={L + gw * i + gw / 2} y={H - 12} textAnchor="middle" className="cmp-x">{LOAD_LABEL[l] ?? l}</text>
              </g>
            );
          })}
          <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="cmp-axis" />
        </svg>
        {hover && <div className="cmp-tip" style={{ left: hover.x, top: hover.y }}>{hover.text}</div>}
      </div>
    </figure>
  );
}

/** Столбец: скруглённый 4 px верх, прямой низ на базовой линии. */
function bar(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + w - r}Q${x + w},${base - h} ${x + w},${base - h + r}V${base}Z`;
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v * 1.08) return k * p;
  return 10 * p;
}
