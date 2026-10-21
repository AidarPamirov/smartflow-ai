import { useEffect, useState } from 'react';
import { maxFill, parseCorridor, spillTotal, type CorridorCtrl, type CorridorResults, type CorridorRow } from './corridor';
import type { Stat } from './trace';
import { CompareChart, type Metric } from './CompareChart';

const URL_ = `${import.meta.env.BASE_URL}data/sumo/corridor-results.json`;
const LOAD_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' };
export const CORR_LABEL: Record<CorridorCtrl, string> = {
  fixed: 'Фиксированные, независимо',
  coordinated: 'Фиксированные, «зелёная волна»',
  adaptive: 'Адаптивные, независимо',
};
const nf = (x: number | null | undefined, d = 1) => (x == null ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const st = (s: Stat | undefined, d = 1) => (!s || s[0] == null ? '—' : `${nf(s[0], d)}${s[1] ? ` ± ${nf(s[1], d)}` : ''}`);

type Status = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error'; msg: string } | { kind: 'ready'; data: CorridorResults };

/** Раздел страницы #sumo: коридор из нескольких перекрёстков. Если файла нет — раздел честно сообщает об этом. */
export function CorridorSection() {
  const [s, setS] = useState<Status>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    fetch(URL_)
      .then(async (r) => {
        if (r.status === 404) return { kind: 'missing' } as Status;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { kind: 'ready', data: parseCorridor(await r.json()) } as Status;
      })
      .then((x) => { if (alive) setS(x); })
      .catch((e: Error) => { if (alive) setS({ kind: 'error', msg: e.message }); });
    return () => { alive = false; };
  }, []);
  if (s.kind === 'loading') return null;
  if (s.kind === 'missing') return <section className="panel"><h2>Коридор проспекта Чуй</h2><p className="hint">Результаты коридора ещё не рассчитаны.</p></section>;
  if (s.kind === 'error') return <section className="panel"><h2>Коридор проспекта Чуй</h2><p className="hint">Результаты коридора не загрузились: {s.msg}.</p></section>;
  return <Corridor data={s.data} />;
}

function Scheme({ data }: { data: CorridorResults }) {
  const xs = data.corridor.nodes.map((n) => n.x);
  const x0 = Math.min(...xs) - 150, x1 = Math.max(...xs) + 150;
  const W = 760, X = (x: number) => 20 + ((x - x0) / (x1 - x0)) * (W - 40);
  return (
    <svg className="corr-scheme" viewBox={`0 0 ${W} 90`} role="img" aria-label="Схема коридора: перекрёстки и расстояния между ними">
      <line x1={X(x0)} y1={45} x2={X(x1)} y2={45} className="corr-road" />
      <text x={X(x0)} y={70} className="corr-end">← запад</text>
      <text x={X(x1)} y={70} className="corr-end" textAnchor="end">восток →</text>
      {data.corridor.nodes.map((n, i) => (
        <g key={n.id}>
          <line x1={X(n.x)} y1={20} x2={X(n.x)} y2={70} className="corr-cross" />
          <circle cx={X(n.x)} cy={45} r={7} className="corr-node" />
          <text x={X(n.x)} y={14} textAnchor="middle" className="corr-name">{n.title.replace('Чуй × ', '')}</text>
          {i > 0 && <text x={(X(n.x) + X(data.corridor.nodes[i - 1].x)) / 2} y={60} textAnchor="middle" className="corr-dist">{data.corridor.spacing_m[i - 1]} м</text>}
        </g>
      ))}
    </svg>
  );
}

function Corridor({ data }: { data: CorridorResults }) {
  const loads = [...Object.keys(data.params.loads_veh_h), ...(data.params.incident && data.summary.some((r) => r.load === 'incident') ? ['incident'] : [])];
  const ctrls: CorridorCtrl[] = ['fixed', 'coordinated', 'adaptive'];
  const row = (l: string, c: CorridorCtrl) => data.summary.find((r) => r.load === l && r.controller === c);
  const nodes = data.corridor.nodes;
  const metrics: { label: string; get: (r: CorridorRow) => Stat; d: number; unit: string; better?: 'lower' | 'higher' }[] = [
    { label: 'Среднее ожидание на поездку', get: (r) => r.mean_wait, d: 1, unit: 'с', better: 'lower' },
    { label: 'Средняя потеря времени', get: (r) => r.mean_time_loss, d: 1, unit: 'с', better: 'lower' },
    { label: 'Суммарная потеря времени сети', get: (r) => r.total_time_loss_veh_h, d: 1, unit: 'авт·ч', better: 'lower' },
    { label: '95-й перцентиль времени поездки', get: (r) => r.p95_travel_time, d: 0, unit: 'с', better: 'lower' },
    { label: 'Проезд всего коридора на восток', get: (r) => r.through_time_eb, d: 0, unit: 'с', better: 'lower' },
    { label: '…остановок по пути', get: (r) => r.through_stops_eb, d: 2, unit: '', better: 'lower' },
    { label: 'Проезд всего коридора на запад', get: (r) => r.through_time_wb, d: 0, unit: 'с', better: 'lower' },
    { label: '…остановок по пути', get: (r) => r.through_stops_wb, d: 2, unit: '', better: 'lower' },
    { label: 'Остановок на поездку', get: (r) => r.mean_stops, d: 2, unit: '', better: 'lower' },
    { label: 'Выехало из сети', get: (r) => r.throughput_veh_h, d: 0, unit: 'авт/ч', better: 'higher' },
  ];
  const cmpMetrics: Metric[] = [
    { id: 'wait', label: 'ожидание', unit: 'с на поездку', digits: 1, lowerBetter: true, get: (l, c) => row(l, c as CorridorCtrl)?.mean_wait },
    { id: 'p95', label: 'p95 поездки', unit: 'с', digits: 0, lowerBetter: true, get: (l, c) => row(l, c as CorridorCtrl)?.p95_travel_time },
    { id: 'eb', label: 'весь коридор на восток', unit: 'с', digits: 0, lowerBetter: true, get: (l, c) => row(l, c as CorridorCtrl)?.through_time_eb },
    { id: 'wb', label: 'на запад', unit: 'с', digits: 0, lowerBetter: true, get: (l, c) => row(l, c as CorridorCtrl)?.through_time_wb },
    { id: 'stops', label: 'остановки', unit: 'на поездку', digits: 2, lowerBetter: true, get: (l, c) => row(l, c as CorridorCtrl)?.mean_stops },
    { id: 'spill', label: 'очередь до соседа', unit: 'с за прогон', digits: 0, lowerBetter: true, loads,
      get: (l, c) => { const r = row(l, c as CorridorCtrl); return r ? [spillTotal(r), null] : undefined; } },
  ];
  const safety = data.summary.reduce((a, r) => ({ c: a.c + r.collisions, k: a.k + r.conflict_steps, t: a.t + r.teleports, o: a.o + r.safety_overrides, f: a.f + r.fallbacks }), { c: 0, k: 0, t: 0, o: 0, f: 0 });
  const runs = data.summary.reduce((a, r) => a + r.runs, 0);
  const holds = data.summary.filter((r) => (r.clearance_hold_s?.[0] ?? 0) > 0)
    .map((r) => `${r.load === 'incident' ? 'ДТП' : LOAD_LABEL[r.load] ?? r.load}, ${CORR_LABEL[r.controller].toLowerCase()} — в среднем ${nf(r.clearance_hold_s![0], 0)} с за прогон`);
  return (
    <section className="panel corr">
      <h2>{data.corridor.title}</h2>
      <p className="hint">
        Четыре связанных перекрёстка в одной сети SUMO {data.sumo_version.replace('SUMO ', '')}: очередь одного светофора может дойти до соседнего,
        а выигрыш одного узла — обернуться проигрышем другого. Три способа управления на одних и тех же маршрутах, {data.params.seeds.length} seed ×
        {' '}{data.params.duration_s / 60} мин на каждую нагрузку, всего {runs} прогонов. Цель — лучший вариант среди проверенных, а не оптимум для города.
      </p>
      <Scheme data={data} />
      <CompareChart title="Коридор: три способа управления" loads={Object.keys(data.params.loads_veh_h)} metrics={cmpMetrics}
        series={[{ key: 'fixed', label: 'фиксированные', color: 'var(--ctl-fixed)' }, { key: 'coordinated', label: '«зелёная волна»', color: 'var(--ctl-coord)' },
          { key: 'adaptive', label: 'адаптивные', color: 'var(--ctl-adaptive)' }]} />
      <ul className="sumo-list">
        <li><b>{CORR_LABEL.fixed}</b>: план Уэбстера на каждом перекрёстке, циклы {data.params.fixed.map((f) => `${f.node} ${f.cycle} с`).join(', ')}, без сдвигов.</li>
        <li><b>{CORR_LABEL.coordinated}</b>: общий цикл {data.params.coordinated[0]?.cycle} с, сдвиги {data.params.coordinated.map((f) => `${f.node} ${f.offset} с`).join(', ')} — зелёный для прямого на восток начинается по мере подхода машин со скоростью {data.params.wave_speed_kmh} км/ч.</li>
        <li><b>{CORR_LABEL.adaptive}</b>: тот же адаптивный контроллер, что на одиночном перекрёстке, на каждом узле свой; друг о друге они не знают.</li>
      </ul>
      {loads.map((l) => (
        <div key={l} className="corr-load">
          <h3>{l === 'incident' ? `Стресс-сценарий: ${data.params.incident?.title}` : `Нагрузка: ${LOAD_LABEL[l] ?? l}`}</h3>
          {l === 'incident' && data.params.incident && (
            <p className="hint">
              Поток на восток {data.params.incident.flows_veh_h.W_END} авт/ч, на запад {data.params.incident.flows_veh_h.E_END} авт/ч, без поперечных улиц.
              Выезд за последним перекрёстком почти перекрыт с {data.params.incident.closures[0]?.from_s} по {data.params.incident.closures[0]?.to_s} с,
              прогон {data.params.incident.duration_s / 60} мин. Сценарий проверяет, что распространение очереди измеряется и как его меняет управление.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Метрика</th>{ctrls.map((c) => <th key={c}>{CORR_LABEL[c]}</th>)}</tr></thead>
              <tbody>
                {metrics.map((m, i) => {
                  const vals = ctrls.map((c) => { const r = row(l, c); return r ? m.get(r)[0] : null; });
                  const nums = vals.filter((v): v is number => v !== null);
                  const goal = m.better === 'higher' ? Math.max(...nums) : Math.min(...nums);
                  const win = ctrls.filter((_, k) => vals[k] !== null && (m.better === 'higher' ? vals[k]! >= goal * 0.99 : vals[k]! <= goal * 1.01));
                  return (
                    <tr key={i}>
                      <td>{m.label}{m.unit ? `, ${m.unit}` : ''}</td>
                      {ctrls.map((c) => { const r = row(l, c); return <td key={c} className={`mono${win.includes(c) && win.length < 3 ? ' corr-best' : ''}`}>{r ? st(m.get(r), m.d) : '—'}</td>; })}
                    </tr>
                  );
                })}
                <tr><td>Средняя очередь у узлов ({nodes.map((n) => n.id).join(' / ')}), авт</td>
                  {ctrls.map((c) => { const r = row(l, c); return <td key={c} className="mono small">{r ? nodes.map((n) => nf(r.queue_by_node[n.id]?.[0], 1)).join(' / ') : '—'}</td>; })}</tr>
                <tr><td>Наибольшее заполнение участка между узлами</td>
                  {ctrls.map((c) => { const r = row(l, c); return <td key={c} className="mono">{r ? `${Math.round(maxFill(r) * 100)} %` : '—'}</td>; })}</tr>
                <tr><td>Очередь дошла до предыдущего перекрёстка (стоит в первых {data.params.spill_zone_m} м участка), с</td>
                  {ctrls.map((c) => { const r = row(l, c); return <td key={c} className="mono">{r ? nf(spillTotal(r), 0) : '—'}</td>; })}</tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="hint">
        Выделены лучшие значения строки (с точностью 1 %). Безопасность во всех {runs} прогонах: столкновений {safety.c}, шагов с конфликтующими зелёными {safety.k},
        телепортаций {safety.t}, вмешательств стража {safety.o}, переходов в резерв {safety.f}.
        {holds.length > 0 && <> Страж продлевал «все красные», пока в зоне перекрёстка стояла машина: {holds.join('; ')}.</>}
      </p>
      <details className="corr-assume">
        <summary>Модель коридора и допущения</summary>
        <p className="hint">{data.corridor.source}</p>
        <ul className="sumo-list">{data.corridor.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </details>
    </section>
  );
}
