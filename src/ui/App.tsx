import { useCallback, useEffect, useRef, useState } from 'react';
import { drawScene, readTheme, type Theme } from '../render/draw';
import {
  ALL_RED, CONTROLLER_LABEL, DEFAULT_ADAPTIVE, DEFAULT_FIXED, YELLOW, validateSpec,
  type AdaptiveSpec, type ControllerSpec, type FixedSpec,
} from '../sim/controllers';
import { DIRS, DIR_LABEL, MANEUVERS, MANEUVER_LABEL, type Dir, type LaneUse, type Maneuver } from '../sim/geometry';
import type { Summary } from '../sim/metrics';
import type { LeftMode, UturnAllowed } from '../sim/phases';
import {
  DT, MAX_FLOW, Simulation, defaultTurns, effectiveShares, validateFlows, validateTurns, type Flows, type Turns,
} from '../sim/simulation';
import { ExperimentPanel } from './ExperimentPanel';
import { LineChart, type Series } from './LineChart';
import { fmt, fmtTime } from './format';

const SPEEDS = [1, 2, 5, 10, 20];
const DEFAULT_FLOWS: Flows = { N: 600, E: 300, S: 600, W: 300 };
const MAX_STEPS_PER_FRAME = 600;
const MAN_COLOR: Record<Maneuver, string> = { T: 'var(--man-T)', L: 'var(--man-L)', R: 'var(--man-R)', U: 'var(--man-U)' };

interface Snapshot {
  summary: Summary;
  samples: Simulation['metrics']['samples'];
  queues: Record<Dir, number>;
  queueByMan: Record<Maneuver, number>;
  structure: string; // структурные настройки, с которыми создана текущая симуляция
}

const structureKey = (u: UturnAllowed, m: LeftMode, l: LaneUse) => JSON.stringify([u, m, l]);

function snapshot(sim: Simulation): Snapshot {
  const queues = {} as Record<Dir, number>;
  for (const d of DIRS) queues[d] = sim.queueOf(d);
  return {
    summary: sim.summary(),
    samples: sim.metrics.samples.slice(),
    queues,
    queueByMan: sim.queueByManeuver(),
    structure: structureKey(sim.uturn, sim.leftMode, sim.laneUse),
  };
}

export function App() {
  const [flows, setFlows] = useState<Flows>(DEFAULT_FLOWS);
  const [turns, setTurns] = useState<Turns>(defaultTurns);
  const [uturn, setUturn] = useState<UturnAllowed>({ N: false, E: false, S: false, W: false });
  const [leftMode, setLeftMode] = useState<LeftMode>('permissive');
  const [laneUse, setLaneUse] = useState<LaneUse>('dedicated');
  const [kind, setKind] = useState<ControllerSpec['kind']>('adaptive');
  const [fixed, setFixed] = useState<FixedSpec>(DEFAULT_FIXED);
  const [adaptive, setAdaptive] = useState<AdaptiveSpec>(DEFAULT_ADAPTIVE);
  const [seed, setSeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [debug, setDebug] = useState(false);
  const [zoom, setZoom] = useState<'near' | 'far'>('near');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spec: ControllerSpec = kind === 'fixed' ? fixed : adaptive;
  const specError = validateSpec(spec);

  const simRef = useRef<Simulation | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<Theme | null>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  const debugRef = useRef(debug);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  runningRef.current = running;
  speedRef.current = speed;
  debugRef.current = debug;

  const draw = useCallback(() => {
    const canvas = canvasRef.current, sim = simRef.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setError('Браузер не поддерживает Canvas 2D'); return; }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!themeRef.current) themeRef.current = readTheme(wrapRef.current ?? document.body);
    drawScene(ctx, sim, w, h, themeRef.current, { debug: debugRef.current, view: zoomRef.current === 'near' ? 45 : undefined });
    // HUD обновляется каждый кадр вместе с холстом, чтобы не отставать от светофоров
    const hud = hudRef.current;
    if (hud) {
      const sg = sim.signal;
      const stage = { green: 'зелёный', yellow: 'жёлтый', allred: 'все красные' }[sg.stage];
      hud.children[0].textContent = `t = ${fmtTime(sim.t)}`;
      hud.children[1].textContent = sg.stage === 'allred'
        ? `смена фаз → ${sim.phases[sg.next].label} · все красные ${sg.elapsed.toFixed(0)} с`
        : `${sim.currentPhase().label} · ${stage} ${sg.elapsed.toFixed(0)} с`;
    }
  }, []);

  /** Новая симуляция с текущими настройками (кнопка «Перезапуск»). */
  const reset = useCallback(() => {
    try {
      const sim = new Simulation({
        seed, flows: { ...flows }, controller: spec, turns: JSON.parse(JSON.stringify(turns)),
        uturn: { ...uturn }, leftMode, laneUse,
      });
      simRef.current = sim;
      setSnap(snapshot(sim));
      setError(null);
      draw();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, flows, spec, turns, uturn, leftMode, laneUse, draw]);

  useEffect(() => { reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => { themeRef.current = null; draw(); };
    mq.addEventListener('change', h);
    const mo = new MutationObserver(h);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', draw);
    return () => { mq.removeEventListener('change', h); mo.disconnect(); window.removeEventListener('resize', draw); };
  }, [draw]);

  // главный цикл: фиксированный шаг DT, накопитель времени
  useEffect(() => {
    let raf = 0, last = performance.now(), acc = 0, lastUi = 0;
    const loop = (now: number) => {
      const frame = Math.min(0.1, (now - last) / 1000);
      last = now;
      const sim = simRef.current;
      if (sim && runningRef.current) {
        acc += frame * speedRef.current;
        let n = 0;
        try {
          while (acc >= DT && n < MAX_STEPS_PER_FRAME) { sim.step(); acc -= DT; n++; }
        } catch (e) {
          setError(`Симуляция остановлена: ${e instanceof Error ? e.message : String(e)}`);
          setRunning(false);
        }
        if (n === MAX_STEPS_PER_FRAME) acc = 0;
        if (now - lastUi > 250) { setSnap(snapshot(sim)); lastUi = now; }
      } else acc = 0;
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  const changeFlow = (d: Dir, raw: number) => {
    const v = Math.round(Math.min(MAX_FLOW, Math.max(0, Number.isFinite(raw) ? raw : 0)));
    setFlows((f) => ({ ...f, [d]: v }));
    simRef.current?.setFlow(d, v);
  };
  const changeTurn = (d: Dir, m: Maneuver, raw: number) => {
    const v = Math.round(Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 0)));
    const next = { ...turns, [d]: { ...turns[d], [m]: v } };
    setTurns(next);
    simRef.current?.setTurns(d, next[d]); // доли применяются к новым прибытиям сразу
  };

  const applySpec = (s: ControllerSpec) => {
    if (validateSpec(s)) return;
    simRef.current?.setController(s);
  };
  const updFixed = (p: Partial<FixedSpec>) => { const s = { ...fixed, ...p }; setFixed(s); if (kind === 'fixed') applySpec(s); };
  const updAdaptive = (p: Partial<AdaptiveSpec>) => { const s = { ...adaptive, ...p }; setAdaptive(s); if (kind === 'adaptive') applySpec(s); };
  const switchKind = (k: ControllerSpec['kind']) => { setKind(k); applySpec(k === 'fixed' ? fixed : adaptive); };

  const s = snap?.summary;
  const samples = snap?.samples ?? [];
  const step = Math.max(1, Math.ceil(samples.length / 400));
  const thin = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  const activeMans = MANEUVERS.filter((m) => m !== 'U' || DIRS.some((d) => uturn[d]));
  const queueSeries: Series[] = activeMans.map((m) => ({
    name: MANEUVER_LABEL[m], color: MAN_COLOR[m], points: thin.map((p) => ({ x: p.t, y: p.queue[m] })),
  }));
  const waitSeries: Series[] = [
    { name: 'Среднее ожидание', color: 'var(--series-wait)', points: thin.map((p) => ({ x: p.t, y: p.avgWait })) },
  ];
  const flowsError = validateFlows(flows);
  const turnsError = validateTurns(turns);
  const pendingRestart = snap && snap.structure !== structureKey(uturn, leftMode, laneUse);
  const sharedProtected = leftMode === 'protected' && laneUse === 'shared';
  const safetyOk = s && s.safety.zoneViolations + s.safety.overlaps + s.safety.redViolations === 0;

  return (
    <div className="app" ref={wrapRef}>
      <header className="top">
        <div>
          <h1>SmartFlow AI <span className="ver">v0.2</span></h1>
          <p className="sub">Лаборатория управления светофорным перекрёстком · повороты, развороты, конфликтные зоны · модель IDM, шаг {DT} с</p>
        </div>
      </header>

      {error && <div className="banner error" role="alert">{error} <button className="btn small" onClick={() => setError(null)}>Закрыть</button></div>}

      <main className="grid">
        <section className="panel sim">
          <div className="toolbar">
            <button className="btn primary" onClick={() => setRunning((r) => !r)} disabled={!!error && !simRef.current}>
              {running ? '❚❚ Пауза' : '▶ Старт'}
            </button>
            <button className="btn" onClick={() => { setRunning(false); reset(); }} title="Новая симуляция с текущими настройками и seed">↺ Перезапуск</button>
            <div className="seg" role="group" aria-label="Скорость">
              {SPEEDS.map((x) => (
                <button key={x} className={x === speed ? 'on' : ''} onClick={() => setSpeed(x)}>{x}×</button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Масштаб">
              <button className={zoom === 'near' ? 'on' : ''} onClick={() => { zoomRef.current = 'near'; setZoom('near'); draw(); }}>перекрёсток</button>
              <button className={zoom === 'far' ? 'on' : ''} onClick={() => { zoomRef.current = 'far'; setZoom('far'); draw(); }}>обзор</button>
            </div>
            <label className="check">
              <input id="debug" type="checkbox" checked={debug} onChange={(e) => { setDebug(e.target.checked); debugRef.current = e.target.checked; draw(); }} />
              траектории и зоны
            </label>
            <label className="seed">seed
              <input id="seed" type="number" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(+e.target.value || 0)))} />
            </label>
          </div>
          {pendingRestart && (
            <div className="banner info">Изменены разметка, режим левого поворота или развороты — они применятся после «Перезапуска».</div>
          )}
          <div className="canvas-wrap">
            <canvas ref={canvasRef} aria-label="Перекрёсток: визуализация симуляции" />
            <div className="hud mono" ref={hudRef}>
              <div>t = 00:00</div>
              <div />
              <div className="muted">{CONTROLLER_LABEL[kind]}</div>
            </div>
          </div>
          <p className="legend-line muted small">
            {activeMans.map((m) => <span key={m} className="legend-item"><i style={{ background: MAN_COLOR[m] }} />{MANEUVER_LABEL[m].toLowerCase()}</span>)}
            <span className="legend-item"><i style={{ background: 'var(--brake)' }} />торможение / стоит</span>
            <span className="legend-item"><i className="ring" />зелёный с уступкой</span>
          </p>
          {debug && (
            <p className="legend-line muted small">
              Отладка: линии — траектории манёвров (пунктир — сейчас красный); <span className="legend-item"><i style={{ background: 'var(--zone)' }} />зона, которую держит машина с допуском</span>
              <span className="legend-item"><i style={{ background: 'var(--zone-other)' }} />та же зона на конфликтующем пути</span>; обведены машины с допуском до стоп-линии.
            </p>
          )}
        </section>

        <aside className="panel side">
          <h2>Алгоритм управления</h2>
          <div className="seg wide" role="group">
            <button className={kind === 'fixed' ? 'on' : ''} onClick={() => switchKind('fixed')}>Фиксированный</button>
            <button className={kind === 'adaptive' ? 'on' : ''} onClick={() => switchKind('adaptive')}>Адаптивный</button>
          </div>
          {kind === 'fixed' ? (
            <div className="params">
              <NumField id="g-ns" label="Зелёный С–Ю, с" value={fixed.greenNS} onChange={(v) => updFixed({ greenNS: v })} />
              <NumField id="g-ew" label="Зелёный В–З, с" value={fixed.greenEW} onChange={(v) => updFixed({ greenEW: v })} />
              {leftMode === 'protected' && <NumField id="g-l" label="Зелёный левых, с" value={fixed.greenLeft} onChange={(v) => updFixed({ greenLeft: v })} />}
              <p className="hint">
                Цикл = {leftMode === 'protected'
                  ? fixed.greenNS + fixed.greenEW + 2 * fixed.greenLeft + 4 * (YELLOW + ALL_RED)
                  : fixed.greenNS + fixed.greenEW + 2 * (YELLOW + ALL_RED)} с, после каждой фазы жёлтый {YELLOW} с и «все красные» {ALL_RED} с.
              </p>
            </div>
          ) : (
            <div className="params">
              <NumField id="a-min" label="Мин. зелёный, с" value={adaptive.minGreen} onChange={(v) => updAdaptive({ minGreen: v })} />
              <NumField id="a-max" label="Макс. зелёный, с" value={adaptive.maxGreen} onChange={(v) => updAdaptive({ maxGreen: v })} />
              <NumField id="a-w" label="Вес ожидания, с/авт" value={adaptive.waitWeight} onChange={(v) => updAdaptive({ waitWeight: v })} />
              <p className="hint">
                Правила, не ML: зелёный не короче минимума; завершается при разрыве потока в зоне детектора (40 м), по максимуму
                или когда давление другой фазы (очередь + ожидание / вес) вдвое выше. Фазы без спроса пропускаются.
              </p>
            </div>
          )}
          {specError && <p className="error">{specError}. Применяется предыдущая корректная настройка.</p>}

          <h2>Схема перекрёстка</h2>
          <div className="params">
            <div className="field">
              <span>Левый поворот</span>
              <div className="seg wide" role="group">
                <button className={leftMode === 'permissive' ? 'on' : ''} onClick={() => setLeftMode('permissive')}>с уступкой</button>
                <button className={leftMode === 'protected' ? 'on' : ''} onClick={() => setLeftMode('protected')}>отдельная фаза</button>
              </div>
            </div>
            <div className="field">
              <span>Левая полоса</span>
              <div className="seg wide" role="group">
                <button className={laneUse === 'dedicated' ? 'on' : ''} onClick={() => setLaneUse('dedicated')}>только налево</button>
                <button className={laneUse === 'shared' ? 'on' : ''} onClick={() => setLaneUse('shared')}>налево + прямо</button>
              </div>
            </div>
            {sharedProtected && (
              <p className="warn">Общая полоса при отдельной левой фазе: прямые и левые блокируют друг друга, пропускная способность резко падает. Это реальный эффект, а не ошибка.</p>
            )}
            <p className="hint">
              {leftMode === 'permissive'
                ? '2 фазы. Налево и разворот разрешены на зелёный, но уступают встречному прямому потоку (интервал ≥ время проезда зоны + 1,5 с).'
                : '4 фазы: левые С–Ю → прямые С–Ю → левые В–З → прямые В–З. Встречные левые не пересекаются и идут одновременно.'}
            </p>
          </div>

          <h2>Потоки и манёвры</h2>
          <div className="table-wrap">
            <table className="turns">
              <thead>
                <tr><th>Въезд</th><th>авт/ч</th>{MANEUVERS.map((m) => <th key={m} title={MANEUVER_LABEL[m]} style={{ color: 'inherit' }}><i className="dot" style={{ background: MAN_COLOR[m] }} />{m === 'T' ? '↑' : m === 'L' ? '↰' : m === 'R' ? '↱' : '⮌'} %</th>)}<th title="Разворот разрешён">разв.</th></tr>
              </thead>
              <tbody>
                {DIRS.map((d) => {
                  const eff = effectiveShares(turns[d], uturn[d]);
                  return (
                    <tr key={d}>
                      <td>{DIR_LABEL[d]}<div className="muted small">очередь {snap?.queues[d] ?? 0}</div></td>
                      <td><input id={`f-${d}`} type="number" min={0} max={MAX_FLOW} step={50} value={flows[d]} onChange={(e) => changeFlow(d, +e.target.value)} aria-label={`${DIR_LABEL[d]}, авт/ч`} /></td>
                      {MANEUVERS.map((m) => (
                        <td key={m}>
                          <input
                            id={`t-${d}-${m}`} type="number" min={0} max={100} step={5} className="pct"
                            value={turns[d][m]} disabled={m === 'U' && !uturn[d]}
                            onChange={(e) => changeTurn(d, m, +e.target.value)}
                            aria-label={`${DIR_LABEL[d]}: ${MANEUVER_LABEL[m]}, %`}
                            title={`фактическая доля ${(eff[m] * 100).toFixed(0)} %`}
                          />
                        </td>
                      ))}
                      <td><input id={`u-${d}`} type="checkbox" checked={uturn[d]} onChange={(e) => setUturn({ ...uturn, [d]: e.target.checked })} aria-label={`Разворот с въезда ${DIR_LABEL[d]}`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {flowsError && <p className="error">{flowsError}</p>}
          {turnsError && <p className="error">{turnsError}</p>}
          <p className="hint">Доли нормируются по сумме въезда; при запрещённом развороте его доля не учитывается. Потоки и доли применяются сразу; разрешение разворотов — после перезапуска.</p>
        </aside>

        <section className="panel kpis">
          <Kpi label="Обслужено" value={fmt(s?.served ?? 0, 0)} unit="авт" />
          <Kpi label="В системе" value={fmt(s?.inSystem ?? 0, 0)} unit="авт" />
          <Kpi label="Среднее ожидание" value={fmt(s?.avgWait, 1)} unit="с" note={s?.avgWait == null ? 'ещё никто не проехал' : 'по обслуженным'} />
          <Kpi label="Макс. очередь" value={fmt(s?.maxQueue ?? 0, 0)} unit="авт" note="на одном въезде" />
          <Kpi label="Пропускная способность" value={fmt(s?.throughput, 0)} unit="авт/ч" note={s?.throughput == null ? 'нужно ≥ 60 с' : 'обслужено / время'} />
          <Kpi
            label="Безопасность"
            value={s ? (safetyOk ? '✓ OK' : '⚠ нарушения') : '—'}
            note={s ? `общие зоны ${s.safety.zoneViolations} · кузова ${s.safety.overlaps} · на красный ${s.safety.redViolations} · мин. зазор ${fmt(Number.isFinite(s.safety.minGap) ? s.safety.minGap : null, 1)} м` : ''}
          />
        </section>

        <section className="panel mans">
          <h2>Статистика по манёврам</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Манёвр</th><th>Обслужено</th><th>Ср. ожидание</th><th>Очередь сейчас</th><th>Макс. очередь</th></tr></thead>
              <tbody>
                {activeMans.map((m) => {
                  const st = s?.byManeuver[m];
                  return (
                    <tr key={m}>
                      <td><i className="dot" style={{ background: MAN_COLOR[m] }} />{MANEUVER_LABEL[m]}</td>
                      <td className="mono">{fmt(st?.served ?? 0, 0)}</td>
                      <td className="mono">{st?.avgWait == null ? <span className="muted">нет данных</span> : `${fmt(st.avgWait, 1)} с`}</td>
                      <td className="mono">{snap?.queueByMan[m] ?? 0}</td>
                      <td className="mono">{st?.maxQueue ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint">Очередь — стоящие перед стоп-линией и ожидающие въезда машины этого манёвра на всех въездах. «Макс. очередь» замеряется раз в секунду.</p>
        </section>

        <section className="panel charts">
          <LineChart title="Очередь по манёврам" unit="авт" series={queueSeries} format={(y) => y.toFixed(0)} empty="Нет данных — запустите симуляцию." />
          <LineChart title="Среднее ожидание обслуженных автомобилей" unit="с" series={waitSeries} empty="Нет данных — ни один автомобиль ещё не проехал перекрёсток." />
        </section>

        <ExperimentPanel scenario={{ flows, turns, uturn, leftMode, laneUse }} fixed={fixed} adaptive={adaptive} baseSeed={seed} />
      </main>

      <footer className="foot muted small">
        Модель: машины движутся по траекториям манёвров (кривые Безье, разворот — дуга R = 3,5 м) с ограничением бокового ускорения 2,5 м/с²;
        въезд в перекрёсток — только при свободных конфликтных зонах (геометрическая проверка кузовов). Перестроений, пешеходов и
        разной длины машин нет. Ожидание — время со скоростью &lt; 0,5 м/с, включая ожидание въезда в модель.
      </footer>
    </div>
  );
}

function Kpi({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}{unit && <span className="kpi-unit"> {unit}</span>}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

function NumField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="num" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : +e.target.value)} />
    </label>
  );
}
