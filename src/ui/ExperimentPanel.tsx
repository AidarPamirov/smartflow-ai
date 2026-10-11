import { useRef, useState } from 'react';
import { CONTROLLER_LABEL, type AdaptiveSpec, type FixedSpec } from '../sim/controllers';
import { aggregate, runExperiment, validateExperiment, type Aggregate, type ExperimentRun, type Scenario } from '../sim/experiment';
import { DIRS, MANEUVERS, MANEUVER_LABEL } from '../sim/geometry';
import { fmt } from './format';

interface Props {
  scenario: Required<Scenario>;
  fixed: FixedSpec;
  adaptive: AdaptiveSpec;
  baseSeed: number;
}

interface Result {
  runs: ExperimentRun[];
  scenario: Required<Scenario>;
  duration: number;
  fixed: Aggregate;
  adaptive: Aggregate;
}

interface Row { label: string; get: (a: Aggregate) => number | null; unit: string; better: 'lower' | 'higher'; digits: number }

export function ExperimentPanel({ scenario, fixed, adaptive, baseSeed }: Props) {
  const [duration, setDuration] = useState(1800);
  const [repeats, setRepeats] = useState(3);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef({ cancelled: false });

  const seeds = Array.from({ length: repeats }, (_, i) => baseSeed + i);
  const snap: Required<Scenario> = JSON.parse(JSON.stringify(scenario));
  const config = { ...snap, duration, seeds, specs: [fixed, adaptive] };
  const invalid = validateExperiment(config);

  const start = async () => {
    setError(null);
    cancel.current = { cancelled: false };
    setProgress({ done: 0, total: seeds.length * 2 });
    try {
      const runs = await runExperiment(config, (done, total) => setProgress({ done, total }), cancel.current);
      if (cancel.current.cancelled) { setProgress(null); return; }
      const f = aggregate(runs, 'fixed'), a = aggregate(runs, 'adaptive');
      if (!f || !a) throw new Error('Нет результатов прогонов');
      setResult({ runs, scenario: snap, duration, fixed: f, adaptive: a });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setProgress(null);
  };

  const usesU = (sc: Required<Scenario>) => DIRS.some((d) => sc.uturn[d] && sc.turns[d].U > 0);
  const rows: Row[] = [
    { label: 'Среднее ожидание', get: (a) => a.avgWait, unit: 'с', better: 'lower', digits: 1 },
    ...MANEUVERS.filter((m) => m !== 'U' || (result && usesU(result.scenario))).map<Row>((m) => ({
      label: `  ${MANEUVER_LABEL[m].toLowerCase()}`, get: (a) => a.waitBy[m], unit: 'с', better: 'lower', digits: 1,
    })),
    { label: 'Средняя задержка', get: (a) => a.avgDelay, unit: 'с', better: 'lower', digits: 1 },
    { label: 'Макс. очередь (въезд)', get: (a) => a.maxQueue, unit: 'авт', better: 'lower', digits: 1 },
    { label: 'Обслужено', get: (a) => a.served, unit: 'авт', better: 'higher', digits: 0 },
    { label: 'Пропускная способность', get: (a) => a.throughput, unit: 'авт/ч', better: 'higher', digits: 0 },
  ];

  const sc = result?.scenario;
  return (
    <section className="panel experiment">
      <header className="panel-head">
        <h2>Эксперимент: сравнение алгоритмов</h2>
        <p className="hint">
          Оба контроллера прогоняются без отрисовки на одних и тех же seed: прибытия и выбор манёвров в каждой паре идентичны.
          Используются текущие потоки, доли манёвров, схема перекрёстка и параметры алгоритмов.
        </p>
      </header>
      <div className="exp-controls">
        <label htmlFor="exp-dur">Длительность
          <select id="exp-dur" value={duration} onChange={(e) => setDuration(+e.target.value)} disabled={!!progress}>
            <option value={600}>10 мин</option><option value={1800}>30 мин</option><option value={3600}>60 мин</option>
          </select>
        </label>
        <label htmlFor="exp-rep">Повторов (seed)
          <select id="exp-rep" value={repeats} onChange={(e) => setRepeats(+e.target.value)} disabled={!!progress}>
            {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="mono muted">seed {seeds[0]}…{seeds[seeds.length - 1]}</span>
        {progress ? (
          <button className="btn" onClick={() => { cancel.current.cancelled = true; }}>Отменить ({progress.done}/{progress.total})</button>
        ) : (
          <button className="btn primary" onClick={start} disabled={!!invalid}>Запустить эксперимент</button>
        )}
      </div>
      {invalid && <p className="error">{invalid}</p>}
      {error && <p className="error">Ошибка эксперимента: {error}</p>}
      {progress && <progress value={progress.done} max={progress.total} />}

      {!result && !progress && (
        <div className="empty">Результатов пока нет. Задайте потоки и манёвры и нажмите «Запустить эксперимент».</div>
      )}

      {result && sc && (
        <>
          <p className="muted small">
            Потоки С/В/Ю/З: {sc.flows.N}/{sc.flows.E}/{sc.flows.S}/{sc.flows.W} авт/ч · левый: {sc.leftMode === 'protected' ? 'отдельная фаза' : 'с уступкой'} ·
            левая полоса: {sc.laneUse === 'dedicated' ? 'только налево' : 'налево + прямо'} · {result.duration / 60} мин · {result.fixed.n} повтор(ов).
            Разница = (адаптивный − фиксированный) / фиксированный.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Метрика (среднее по повторам)</th><th>{CONTROLLER_LABEL.fixed}</th><th>{CONTROLLER_LABEL.adaptive}</th><th>Разница</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const f = r.get(result.fixed), a = r.get(result.adaptive);
                  const delta = f !== null && a !== null && f !== 0 ? (a - f) / f : null;
                  const good = delta === null || Math.abs(delta) < 0.01 ? 'neutral' : (delta < 0) === (r.better === 'lower') ? 'good' : 'bad';
                  const sub = r.label.startsWith('  ');
                  return (
                    <tr key={r.label} className={sub ? 'sub' : ''}>
                      <td>{sub ? `↳ ${r.label.trim()}` : r.label}</td>
                      <td className="mono">{f === null ? '—' : `${fmt(f, r.digits)} ${r.unit}`}</td>
                      <td className="mono">{a === null ? '—' : `${fmt(a, r.digits)} ${r.unit}`}</td>
                      <td className={`mono delta ${good}`}>
                        {delta === null ? '—' : `${delta > 0 ? '+' : ''}${fmt(delta * 100, 1)}%`}
                        {good !== 'neutral' && <span className="tag">{good === 'good' ? 'лучше' : 'хуже'}</span>}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td>Безопасность: общие зоны / кузова / на красный</td>
                  <td className="mono">{result.fixed.zoneViolations} / {result.fixed.overlaps} / {result.fixed.redViolations}</td>
                  <td className="mono">{result.adaptive.zoneViolations} / {result.adaptive.overlaps} / {result.adaptive.redViolations}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <details>
            <summary>Результаты по каждому seed</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>seed</th><th>алгоритм</th><th>прибыло</th><th>обслужено</th><th>ожидание, с</th><th>налево, с</th><th>макс. очередь</th></tr></thead>
                <tbody>
                  {result.runs.map((r) => (
                    <tr key={`${r.seed}-${r.kind}`}>
                      <td className="mono">{r.seed}</td><td>{r.kind === 'fixed' ? 'фикс.' : 'адапт.'}</td>
                      <td className="mono">{r.generated}</td><td className="mono">{r.summary.served}</td>
                      <td className="mono">{fmt(r.summary.avgWait, 1)}</td><td className="mono">{fmt(r.summary.byManeuver.L.avgWait, 1)}</td>
                      <td className="mono">{r.summary.maxQueue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
