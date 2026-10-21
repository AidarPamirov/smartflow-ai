import { useState } from 'react';
import { findComparison, verdict, type Comparison } from './paired';

export interface PairDef { a: string; b: string; label: string }
export interface PairMetric { id: string; label: string; unit: string; digits: number }

const LOAD_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая', incident: 'ДТП на выезде' };
const VERDICT_TEXT = { better: 'лучше', worse: 'хуже', same: 'одинаково', unclear: 'разница не подтверждена' } as const;
const nf = (x: number | null, d: number) => (x == null ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgn = (x: number, d: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${nf(Math.abs(x), d)}`;

/**
 * Таблица парных сравнений: выбранная пара «A против B», строки — метрики, столбцы — нагрузки.
 * В ячейке: средняя разность A − B, её 95 % ДИ, изменение в процентах и в скольких seed A лучше.
 * «Лучше/хуже» пишется только если весь интервал по одну сторону от нуля.
 */
export function PairedTable({ comparisons, pairs, metrics, loads, caption }: {
  comparisons: Comparison[]; pairs: PairDef[]; metrics: PairMetric[]; loads: string[]; caption?: string;
}) {
  const [pi, setPi] = useState(0);
  const p = pairs[Math.min(pi, pairs.length - 1)];
  return (
    <div className="paired">
      <div className="seg cmp-seg" role="group" aria-label="Пара для сравнения">
        {pairs.map((x, i) => <button key={x.a + x.b} className={i === pi ? 'on' : ''} onClick={() => setPi(i)}>{x.label}</button>)}
      </div>
      <div className="table-wrap">
        <table className="paired-table">
          {caption && <caption className="muted small">{caption}</caption>}
          <thead><tr><th>Метрика (A − B)</th>{loads.map((l) => <th key={l}>{LOAD_LABEL[l] ?? l}</th>)}</tr></thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.id}>
                <td>{m.label}{m.unit ? `, ${m.unit}` : ''}</td>
                {loads.map((l) => {
                  const c = findComparison(comparisons, l, p.a, p.b, m.id);
                  if (!c) return <td key={l} className="muted">—</td>;
                  const v = verdict(c);
                  const [lo, hi] = c.diff_ci95;
                  return (
                    <td key={l} className={`paired-cell ${v}`}>
                      <span className="mono">{sgn(c.diff, m.digits)}</span>
                      {c.rel != null && v !== 'same' && <span className="mono"> ({sgn(c.rel * 100, 1)} %)</span>}
                      <div className="muted small">
                        {v === 'same' ? 'одинаково во всех seed' : <>ДИ [{sgn(lo, m.digits)}; {sgn(hi, m.digits)}] · лучше в {c.a_better} из {c.n}</>}
                      </div>
                      <div className={`paired-v ${v}`}>{VERDICT_TEXT[v]}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
