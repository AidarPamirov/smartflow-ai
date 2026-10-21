import { useEffect, useMemo, useRef, useState } from 'react';
import { frameAt, parseResults, parseTrace, vehiclesAt, type ResultRow, type Results, type Trace } from './trace';
import { CorridorSection } from './CorridorSection';
import { CompareChart, type Metric } from './CompareChart';
import './sumo.css';

const BASE = `${import.meta.env.BASE_URL}data/sumo/`;
const SPEEDS = [1, 2, 5, 10];
const LOAD_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' };
const CTRL_LABEL = { fixed: 'Фиксированный цикл', adaptive: 'Адаптивный (очереди и ожидание)' } as const;
const STAGE_LABEL = { green: 'зелёный', yellow: 'жёлтый', allred: 'все красные' } as const;
const CAR_LEN = 4.5, CAR_W = 1.8;

const nf = (x: number | null | undefined, d = 1) => (x == null ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtT = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

type Status = { kind: 'loading' } | { kind: 'error'; msg: string } | { kind: 'ready'; results: Results; traces: Record<'fixed' | 'adaptive', Trace> };

async function getJson(name: string): Promise<unknown> {
  let res: Response;
  try { res = await fetch(BASE + name); } catch { throw new Error(`нет связи с сервером (${name})`); }
  if (!res.ok) throw new Error(`файл ${name} не найден (HTTP ${res.status})`);
  try { return await res.json(); } catch { throw new Error(`файл ${name} повреждён`); }
}

/**
 * Страница эксперимента SUMO. Браузер ничего не моделирует: он проигрывает кадры, записанные
 * при настоящем прогоне SUMO (sumo/smartflow_sumo), и показывает сводку эксперимента.
 */
export default function SumoApp() {
  const [st, setSt] = useState<Status>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setSt({ kind: 'loading' });
    Promise.all([getJson('results.json'), getJson('trace-fixed.json'), getJson('trace-adaptive.json')])
      .then(([r, f, a]) => { if (alive) setSt({ kind: 'ready', results: parseResults(r), traces: { fixed: parseTrace(f), adaptive: parseTrace(a) } }); })
      .catch((e: Error) => { if (alive) setSt({ kind: 'error', msg: e.message }); });
    return () => { alive = false; };
  }, [attempt]);

  return (
    <div className="app sumo">
      <header className="top">
        <div>
          <h1>SmartFlow AI <span className="ver">эксперимент SUMO</span></h1>
          <p className="sub">Перекрёсток Бишкека в SUMO: фиксированный цикл против адаптивного управления через TraCI</p>
        </div>
        <nav className="sumo-nav">
          <a className="top-link" href="#">← Карта Бишкека</a>
          <a className="top-link" href="#lab">Лаборатория перекрёстка</a>
          <a className="top-link" href="#cv">Компьютерное зрение</a>
          <a className="top-link" href="#signal=tls-244504528">Этот светофор на карте города</a>
        </nav>
      </header>
      {st.kind === 'loading' && <div className="panel empty">Загружаю записи симуляции…</div>}
      {st.kind === 'error' && (
        <div className="banner error" role="alert">
          Данные эксперимента не загрузились: {st.msg}. <button className="btn small" onClick={() => setAttempt((x) => x + 1)}>Повторить</button>
        </div>
      )}
      {st.kind === 'ready' && <Experiment results={st.results} traces={st.traces} />}
    </div>
  );
}

function Experiment({ results, traces }: { results: Results; traces: Record<'fixed' | 'adaptive', Trace> }) {
  const tf = traces.fixed;
  const [w0, w1] = tf.meta.window;
  const [t, setT] = useState(w0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [zoom, setZoom] = useState<'near' | 'far'>('near');
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      let nt = tRef.current + dt * speed;
      if (nt > w1) nt = w0;
      setT(nt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, w0, w1]);

  return (
    <main className="sumo-grid">
      <section className="panel sumo-note">
        <h2>{results.scenario.title}</h2>
        <p>
          Ниже — <b>записи настоящих прогонов SUMO {results.sumo_version.replace('SUMO ', '')}</b>, управляемых из Python через TraCI.
          Браузер только проигрывает кадры (раз в {tf.meta.sample_s} с, между кадрами положение машин интерполируется для плавности).
          Нагрузка «{LOAD_LABEL[tf.meta.load] ?? tf.meta.load}», seed {tf.meta.seed}, отрезок с {w0 / 60}-й по {w1 / 60}-ю минуту часового прогона; маршруты у обоих контроллеров одинаковые.
        </p>
        <p className="hint">{tf.meta.approximation_note}</p>
      </section>

      <section className="panel sumo-player">
        <div className="toolbar">
          <button className="btn primary" onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Пауза' : '▶ Смотреть'}</button>
          <div className="seg" role="group" aria-label="Скорость">
            {SPEEDS.map((x) => <button key={x} className={x === speed ? 'on' : ''} onClick={() => setSpeed(x)}>{x}×</button>)}
          </div>
          <div className="seg" role="group" aria-label="Масштаб">
            <button className={zoom === 'near' ? 'on' : ''} onClick={() => setZoom('near')}>перекрёсток</button>
            <button className={zoom === 'far' ? 'on' : ''} onClick={() => setZoom('far')}>все подходы</button>
          </div>
          <label className="sumo-scrub">
            <span className="mono" title="минуты:секунды моделирования">{fmtT(t)}</span>
            <input type="range" min={w0} max={w1} step={0.1} value={t} onChange={(e) => { setPlaying(false); setT(+e.target.value); }} aria-label="Время моделирования" />
          </label>
        </div>
        <div className="sumo-views">
          {(['fixed', 'adaptive'] as const).map((k) => <View key={k} trace={traces[k]} t={t} zoom={zoom} title={CTRL_LABEL[k]} />)}
        </div>
        <p className="legend-line muted small">
          <span className="legend-item"><i style={{ background: 'var(--veh-move)' }} />едет</span>
          <span className="legend-item"><i style={{ background: 'var(--veh-stop)' }} />стоит (скорость &lt; 0,1 м/с)</span>
          <span className="legend-item"><i style={{ background: 'var(--sig-green)' }} />/<i style={{ background: 'var(--sig-yellow)' }} />/<i style={{ background: 'var(--sig-red)' }} /> сигнал каждой связи у стоп-линии</span>
        </p>
      </section>

      <SingleCompare results={results} />
      <ResultsTable results={results} />
      <CorridorSection />
      <Params results={results} />
    </main>
  );
}

function View({ trace, t, zoom, title }: { trace: Trace; t: number; zoom: 'near' | 'far'; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const f = frameAt(trace, t);
  const vehicles = useMemo(() => vehiclesAt(trace, t), [trace, t]);
  const stopped = vehicles.filter((v) => v.speed < 0.1).length;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = W; // квадрат; высоту задаёт CSS (aspect-ratio)
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    const css = getComputedStyle(c);
    const col = (n: string) => css.getPropertyValue(n).trim();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col('--canvas-ground');
    g.fillRect(0, 0, W, H);
    const [bx0, by0, bx1, by1] = trace.geometry.bounds;
    const half = zoom === 'near' ? 85 : Math.max(bx1 - bx0, by1 - by0) / 2 + 5;
    const cx = zoom === 'near' ? 0 : (bx0 + bx1) / 2, cy = zoom === 'near' ? 0 : (by0 + by1) / 2;
    const s = Math.min(W, H) / (2 * half);
    const X = (x: number) => W / 2 + (x - cx) * s;
    const Y = (y: number) => H / 2 - (y - cy) * s;
    // дорога
    g.lineCap = 'butt';
    g.strokeStyle = col('--canvas-road');
    for (const l of trace.geometry.lanes) {
      g.lineWidth = l.width * s;
      g.beginPath();
      for (let i = 0; i < l.shape.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(l.shape[i]), Y(l.shape[i + 1]));
      g.stroke();
    }
    const j = trace.geometry.junction;
    if (j.length >= 6) {
      g.fillStyle = col('--canvas-road');
      g.beginPath();
      for (let i = 0; i < j.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(j[i]), Y(j[i + 1]));
      g.closePath(); g.fill();
    }
    // разметка между полосами
    g.strokeStyle = col('--canvas-mark');
    g.lineWidth = Math.max(0.6, 0.12 * s);
    g.setLineDash([3 * s, 4 * s]);
    for (const l of trace.geometry.lanes) {
      const n = l.shape.length;
      const dx = l.shape[n - 2] - l.shape[0], dy = l.shape[n - 1] - l.shape[1];
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dy / len) * l.width / 2, oy = (-dx / len) * l.width / 2;
      g.beginPath();
      g.moveTo(X(l.shape[0] - ox), Y(l.shape[1] - oy));
      g.lineTo(X(l.shape[n - 2] - ox), Y(l.shape[n - 1] - oy));
      g.stroke();
    }
    g.setLineDash([]);
    // машины: SUMO даёт положение переднего бампера и азимут
    const move = col('--veh-move'), stop = col('--veh-stop');
    for (const v of vehicles) {
      g.save();
      g.translate(X(v.x), Y(v.y));
      g.rotate((v.angle * Math.PI) / 180);
      g.fillStyle = v.speed < 0.1 ? stop : move;
      g.fillRect((-CAR_W / 2) * s, 0, CAR_W * s, CAR_LEN * s);
      g.restore();
    }
    // сигналы, как в sumo-gui: стоп-линия полосы делится на отрезки по числу связей (слева направо: налево, прямо, направо)
    const lanes = new Map(trace.geometry.lanes.map((l) => [l.id, l]));
    const byLane = new Map<string, typeof trace.geometry.links>();
    for (const lk of trace.geometry.links) byLane.set(lk.in_lane, [...(byLane.get(lk.in_lane) ?? []), lk]);
    const order = (m: string) => 'LTRU'.indexOf(m[1] ?? 'T');
    g.lineCap = 'butt';
    g.lineWidth = Math.max(2, 0.8 * s);
    for (const [id, lks] of byLane) {
      const l = lanes.get(id);
      if (!l) continue;
      lks.sort((a, b) => order(a.movement) - order(b.movement));
      const n = l.shape.length;
      const dx = l.shape[n - 2] - l.shape[n - 4], dy = l.shape[n - 1] - l.shape[n - 3];
      const len = Math.hypot(dx, dy) || 1;
      const lx = -dy / len, ly = dx / len; // нормаль влево по ходу движения
      const ex = l.shape[n - 2] - (dx / len) * 0.4, ey = l.shape[n - 1] - (dy / len) * 0.4;
      const w = l.width / lks.length;
      lks.forEach((lk, k) => {
        const a = l.width / 2 - k * w, b = a - w;
        const ch = f.signal[lk.index];
        g.strokeStyle = ch === 'G' || ch === 'g' ? col('--sig-green') : ch === 'y' ? col('--sig-yellow') : col('--sig-red');
        g.beginPath();
        g.moveTo(X(ex + lx * (a - 0.1)), Y(ey + ly * (a - 0.1)));
        g.lineTo(X(ex + lx * (b + 0.1)), Y(ey + ly * (b + 0.1)));
        g.stroke();
      });
    }
  }, [trace, f, vehicles, zoom]);

  return (
    <figure className="sumo-view">
      <figcaption>
        <b>{title}</b>
        <span className="mono muted small">
          {trace.phases[f.phase]?.name} · {STAGE_LABEL[f.stage]} · машин {vehicles.length} · стоят {stopped}
        </span>
      </figcaption>
      <canvas ref={ref} aria-label={`${title}: кадр симуляции SUMO`} />
      <Decisions trace={trace} t={t} />
    </figure>
  );
}

/** Последние решения контроллера к моменту t (журнал из прогона SUMO). */
function Decisions({ trace, t }: { trace: Trace; t: number }) {
  const ds = (trace.decisions ?? []).filter((d) => d.time <= t).slice(-3).reverse();
  if (!trace.decisions) return null;
  return (
    <ol className="sumo-decisions" aria-label="Журнал решений">
      {ds.length === 0 && <li className="muted">решений в этом отрезке ещё не было</li>}
      {ds.map((d) => (
        <li key={d.time} title={d.reason}><span className="mono">{fmtT(d.time)}</span> фаза {d.from_phase + 1} → {d.to_phase + 1}: {d.reason}</li>
      ))}
    </ol>
  );
}

function ResultsTable({ results }: { results: Results }) {
  const loads = Object.keys(results.params.loads_veh_h);
  const row = (l: string, c: 'fixed' | 'adaptive') => results.summary.find((r) => r.load === l && r.controller === c);
  const delta = (a: number | null, b: number | null) => (a == null || b == null || a === 0 ? null : (b - a) / a);
  const metrics: { label: string; get: (r: ResultRow) => [number | null, number | null]; unit: string; d: number; lower: boolean }[] = [
    { label: 'Среднее ожидание на поездку', get: (r) => r.mean_wait, unit: 'с', d: 1, lower: true },
    { label: 'Средняя потеря времени', get: (r) => r.mean_time_loss, unit: 'с', d: 1, lower: true },
    { label: 'Стоящих машин на подходах, в среднем', get: (r) => r.mean_queue, unit: 'авт', d: 1, lower: true },
    { label: 'Макс. очередь на подходе', get: (r) => r.max_queue_approach, unit: 'авт', d: 0, lower: true },
    { label: '95-й перцентиль времени поездки', get: (r) => r.p95_travel_time ?? [null, null], unit: 'с', d: 1, lower: true },
    { label: 'Суммарное ожидание за час', get: (r) => r.total_wait_veh_h ?? [null, null], unit: 'авт·ч', d: 2, lower: true },
    { label: 'Остановок на поездку', get: (r) => r.mean_stops ?? [null, null], unit: '', d: 2, lower: true },
    { label: 'Худший подход: среднее ожидание', get: (r) => r.worst_approach_wait ?? [null, null], unit: 'с', d: 1, lower: true },
    { label: 'Самое долгое ожидание одной машины', get: (r) => r.max_wait_vehicle ?? [null, null], unit: 'с', d: 0, lower: true },
    { label: 'Пропускная способность (выехало)', get: (r) => r.throughput_veh_h ?? [null, null], unit: 'авт/ч', d: 0, lower: false },
    { label: 'Завершено поездок', get: (r) => r.completed, unit: '', d: 0, lower: false },
    { label: 'Не доехали к концу', get: (r) => r.unfinished, unit: '', d: 0, lower: true },
  ];
  return (
    <section className="panel sumo-results">
      <h2>Результаты: {results.params.seeds.length} seed × {results.params.duration_s / 60} мин на каждую нагрузку</h2>
      <p className="hint">
        Среднее по seed {results.params.seeds.join(', ')} (± стандартное отклонение). Ожидание и потеря времени — по поездкам,
        начавшимся после {results.params.warmup_s / 60} мин разогрева (ожидание — время со скоростью ≤ 0,1 м/с).
        Очередь — число стоящих машин на всех подходах, замер каждую секунду с {results.params.warmup_s / 60}-й минуты до конца спроса.
        Разница = (адаптивный − фиксированный) / фиксированный.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Нагрузка</th><th>Метрика</th><th>{CTRL_LABEL.fixed}</th><th>{CTRL_LABEL.adaptive}</th><th>Разница</th></tr>
          </thead>
          <tbody>
            {loads.map((l) => {
              const f = row(l, 'fixed'), a = row(l, 'adaptive');
              if (!f || !a) return null;
              const q = results.params.loads_veh_h[l];
              return metrics.map((m, i) => {
                const [fv, fs] = m.get(f), [av, as] = m.get(a);
                const dl = delta(fv, av);
                const good = dl == null || Math.abs(dl) < 0.01 ? 'neutral' : (dl < 0) === m.lower ? 'good' : 'bad';
                return (
                  <tr key={l + m.label} className={i === 0 ? 'grp' : ''}>
                    {i === 0 && (
                      <td rowSpan={metrics.length} className="sumo-load">
                        <b>{LOAD_LABEL[l] ?? l}</b>
                        <div className="muted small mono">В/З {q.E}/{q.W}<br />С/Ю {q.N}/{q.S} авт/ч</div>
                      </td>
                    )}
                    <td>{m.label}</td>
                    <td className="mono">{nf(fv, m.d)}{fs ? ` ± ${nf(fs, m.d)}` : ''} {m.unit}</td>
                    <td className="mono">{nf(av, m.d)}{as ? ` ± ${nf(as, m.d)}` : ''} {m.unit}</td>
                    <td className={`mono delta ${good}`}>{dl == null ? '—' : `${dl > 0 ? '+' : ''}${nf(dl * 100, 1)}%`}</td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
      <h3>Безопасность во всех прогонах</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Нагрузка</th><th>Контроллер</th><th>Столкновения</th><th>Шаги с конфликтующими зелёными</th><th>Телепортации</th><th>Вмешательства стража</th><th>Переходы в резерв</th><th>Мин. зелёный / жёлтый / все красные, с</th></tr></thead>
          <tbody>
            {results.summary.map((r) => (
              <tr key={r.load + r.controller}>
                <td>{LOAD_LABEL[r.load] ?? r.load}</td><td>{r.controller === 'fixed' ? 'фиксированный' : 'адаптивный'}</td>
                <td className="mono">{r.collisions}</td><td className="mono">{r.conflict_steps}</td><td className="mono">{r.teleports}</td>
                <td className="mono">{r.safety_overrides ?? '—'}</td><td className="mono">{r.fallbacks ?? '—'}</td>
                <td className="mono">{nf(r.min_green_seen, 0)} / {nf(r.min_yellow_seen, 0)} / {nf(r.min_allred_seen, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {results.summary.some((r) => r.decision_reasons) && (
        <>
          <h3>Почему переключались фазы (журнал решений, все seed)</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Нагрузка</th><th>Контроллер</th><th>Причины смены фазы</th></tr></thead>
              <tbody>
                {results.summary.map((r) => (
                  <tr key={r.load + r.controller + 'why'}>
                    <td>{LOAD_LABEL[r.load] ?? r.load}</td><td>{r.controller === 'fixed' ? 'фиксированный' : 'адаптивный'}</td>
                    <td className="small">{Object.entries(r.decision_reasons ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} — ${v}`).join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Params({ results }: { results: Results }) {
  const p = results.params;
  return (
    <section className="panel sumo-params">
      <h2>Как устроен эксперимент</h2>
      <div className="sumo-cols">
        <div>
          <h3>Контроллеры</h3>
          <p><b>Фиксированный цикл</b> рассчитан по Уэбстеру на нагрузку «{LOAD_LABEL[p.fixed.design_load]}» и одинаков для всех нагрузок, как у обычного светофора: цикл {nf(p.fixed.cycle_s, 0)} с, зелёный {p.fixed.phases.map((n, i) => `${n} — ${p.fixed.greens_s[i]} с`).join('; ')}.</p>
          <p><b>Адаптивный</b> (правила, не машинное обучение): зелёный продлевается, пока на полосах фазы есть очередь или машины в 30 м перед стоп-линией; завершается при разрыве потока, по максимуму (1,5 × зелёного расчётного плана) или если другая фаза ждёт дольше 120 с. Следующая фаза — с наибольшим давлением: стоящие машины + ожидание / 20 с.</p>
          <p><b>Страж безопасности</b> общий для обоих: минимальный зелёный {p.timing.min_green} с, жёлтый {p.timing.yellow} с, «все красные» {p.timing.all_red} с, переход только через них. План фаз проверяется по матрице конфликтов сети SUMO; в каждом шаге прогона фактический сигнал в SUMO проверяется ещё раз.</p>
        </div>
        <div>
          <h3>Модель и допущения</h3>
          <ul className="sumo-list">{results.scenario.osm_facts.map((x) => <li key={x}>{x}</li>)}</ul>
          <ul className="sumo-list">{results.scenario.assumptions.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="hint">Доли манёвров: налево {p.turn_shares.L * 100}%, прямо {p.turn_shares.T * 100}%, направо {p.turn_shares.R * 100}% (где правый поворот через светофор не идёт, доли делятся между остальными). Шаг модели {p.step_s} с, {p.duration_s / 60} мин спроса, затем машины доезжают. Модель водителя — Krauss (SUMO по умолчанию), σ = 0,5.</p>
        </div>
      </div>
      <h3>Как повторить</h3>
      <pre className="sumo-code">{`pip install eclipse-sumo==1.28.0 traci==1.28.0 sumolib==1.28.0
cd sumo
python -m unittest discover -s tests -t .
python -m smartflow_sumo.experiment --out ../public/data/sumo`}</pre>
      <p className="hint">Сгенерировано {new Date(results.generated).toLocaleString('ru-RU')}, расчёт занял {nf(results.elapsed_s / 60, 1)} мин. Данные о дорогах © OpenStreetMap contributors, ODbL.</p>
    </section>
  );
}

function SingleCompare({ results }: { results: Results }) {
  const loads = Object.keys(results.params.loads_veh_h);
  const row = (l: string, c: string) => results.summary.find((r) => r.load === l && r.controller === c);
  const metrics: Metric[] = [
    { id: 'wait', label: 'ожидание', unit: 'с на поездку', digits: 1, lowerBetter: true, get: (l, c) => row(l, c)?.mean_wait },
    { id: 'p95', label: 'p95 поездки', unit: 'с', digits: 0, lowerBetter: true, get: (l, c) => row(l, c)?.p95_travel_time },
    { id: 'worst', label: 'худший подход', unit: 'с ожидания', digits: 1, lowerBetter: true, get: (l, c) => row(l, c)?.worst_approach_wait },
    { id: 'stops', label: 'остановки', unit: 'на поездку', digits: 2, lowerBetter: true, get: (l, c) => row(l, c)?.mean_stops },
    { id: 'thr', label: 'выехало', unit: 'авт/ч', digits: 0, lowerBetter: false, get: (l, c) => row(l, c)?.throughput_veh_h },
  ];
  return (
    <section className="panel">
      <h2 className="cmp-h2">Сравнение: один перекрёсток</h2>
      <CompareChart title="Чуй × Манаса" loads={loads} metrics={metrics}
        series={[{ key: 'fixed', label: 'фиксированный (Baseline)', color: 'var(--ctl-fixed)' }, { key: 'adaptive', label: 'адаптивный (Adaptive AI)', color: 'var(--ctl-adaptive)' }]} />
      <p className="hint">Столбец — среднее по {results.params.seeds.length} seed, отрезок — разброс между ними (± ст. отклонение). Точные числа — в таблице ниже. Наведите на столбец, чтобы увидеть значение.</p>
    </section>
  );
}
