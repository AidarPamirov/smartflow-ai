import type { SelectedSignal, TrafficController } from '../traffic/controller';
import type { ControlMode, Light } from './runtime';
import { LIGHT_COLOR } from './signalLayer';

export const MODE_LABEL: Record<ControlMode, string> = { fixed: 'Baseline (фикс.)', adaptive: 'Адаптивный', manual: 'Ручной' };
const STATUS_LABEL = { working: 'работает', inactive: 'выключен', no_data: 'данные недоступны' } as const;
const STAGE_LABEL = { green: 'зелёный', yellow: 'жёлтый', allred: 'все красные' } as const;
const LIGHT_LABEL: Record<Light, string> = { G: 'зелёный', Y: 'жёлтый', R: 'красный', off: 'выключен' };

const Dot = ({ light }: { light: Light | null }) => (
  <i className="sig-dot" style={{ background: light ? LIGHT_COLOR[light] : 'transparent', borderColor: light ? 'transparent' : 'var(--map-muted)' }} title={light ? LIGHT_LABEL[light] : 'без сигнала (только выезд)'} />
);
const Tag = ({ kind, children }: { kind: 'osm' | 'approx' | 'synth' | 'na'; children: string }) => <span className={`dq dq-${kind}`}>{children}</span>;
const t1 = (x: number) => x.toLocaleString('ru-RU', { maximumFractionDigits: 0 });

/** Панель выбранного светофора. Только отображение и команды контроллеру. */
export function SignalPanel({ ctrl, sel }: { ctrl: TrafficController; sel: SelectedSignal }) {
  const working = sel.status === 'working';
  const cur = sel.phases[sel.phase];
  let timing: string;
  if (!sel.stage || !working) timing = 'сигналы не горят';
  else if (sel.timeToSwitch !== null) timing = `до переключения ≈ ${t1(Math.ceil(sel.timeToSwitch))} с`;
  else if (sel.mode === 'adaptive') timing = sel.minGreenLeft > 0 ? `зелёный ещё минимум ${t1(Math.ceil(sel.minGreenLeft))} с, дальше — по очередям` : 'переключение — по очередям и ожиданию';
  else timing = 'держится до команды оператора (не дольше 120 с)';
  return (
    <section className="map-panel sig-panel" aria-label={`Светофор ${sel.id}`}>
      <header className="sig-head">
        <div>
          <h2>Светофор <span className="mono">{sel.id}</span></h2>
          <p className="sig-sub">
            <span className={`sig-st sig-st-${sel.status}`}>{STATUS_LABEL[sel.status]}</span>
            {sel.mode && <span className={`sig-mode sig-mode-${sel.mode}`}>{MODE_LABEL[sel.mode]}</span>}
            <Tag kind="approx">виртуальная модель</Tag>
          </p>
        </div>
        <div className="sig-head-actions">
          <button onClick={() => ctrl.flyToSignal(sel.index)} title="Показать на карте">◎</button>
          <button onClick={() => ctrl.selectSignal(null)} aria-label="Закрыть">✕</button>
        </div>
      </header>

      {sel.zone && (
        <a className="sig-zone" href={sel.zone.href}>Зона детальной симуляции SUMO: {sel.zone.title} — сравнение контроллеров →</a>
      )}
      {sel.note && <p className="sig-note">{sel.note}</p>}

      {working && cur && (
        <div className="sig-now">
          <Dot light={cur.light} />
          <div>
            <b>Фаза {sel.phase + 1}: {cur.label}</b>
            <div className="sig-muted">{sel.stage ? STAGE_LABEL[sel.stage] : ''} · {timing}</div>
          </div>
        </div>
      )}

      {sel.mode && (
        <div className="sig-row" role="group" aria-label="Режим управления">
          {(['fixed', 'adaptive', 'manual'] as ControlMode[]).map((m) => (
            <button key={m} className={sel.mode === m ? 'on' : ''} aria-pressed={sel.mode === m} disabled={!working} onClick={() => ctrl.setSignalMode(sel.index, m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
      )}
      {sel.mode === 'adaptive' && <p className="sig-hint">Адаптивный режим — правила без машинного обучения (актуированное управление): продление зелёного, пока подъезжают машины; смена по «давлению» (очередь + ожидание); защита от бесконечного ожидания. Очереди — из синтетического трафика.</p>}

      {sel.phases.length > 0 && (
        <table className="sig-table">
          <caption>Фазы <Tag kind="approx">план по геометрии</Tag></caption>
          <tbody>
            {sel.phases.map((p, k) => (
              <tr key={k} className={k === sel.phase ? 'cur' : ''}>
                <td><Dot light={p.light} /></td>
                <td>{k + 1}. {p.label}</td>
                <td className="num">{sel.mode === 'fixed' ? `${p.green} с` : ''}</td>
                {sel.mode === 'manual' && <td><button disabled={!working || k === sel.phase} onClick={() => ctrl.requestPhase(sel.index, k)}>включить</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel.mode === 'fixed' && sel.cycle > 0 && <p className="sig-hint">Цикл {sel.cycle} с: после каждой фазы жёлтый 3 с и «все красные» 2 с.</p>}

      <table className="sig-table">
        <caption>Подходы <Tag kind="osm">OSM</Tag> · очереди <Tag kind="synth">синтетика</Tag></caption>
        <thead><tr><th /><th>улица</th><th className="num" title="Полосы на въезд / выезд по тегу lanes">полосы</th><th className="num" title="Стоящие машины в 150 м перед стоп-линией">очередь</th><th className="num" title="Самое долгое ожидание в очереди">ждут</th></tr></thead>
        <tbody>
          {sel.legs.map((l, i) => (
            <tr key={i}>
              <td><Dot light={l.light} /></td>
              <td>{l.name || 'без названия'} <span className="sig-muted">{l.from}</span></td>
              <td className="num">{l.lanesIn || '?'} / {l.lanesOut || '?'}</td>
              <td className="num">{l.light ? l.obs.queue : '—'}</td>
              <td className="num">{l.light && l.obs.queue ? `${t1(l.obs.maxWait)} с` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {sel.log.length > 0 && (
        <details className="sig-log" open>
          <summary>Журнал решений (последние {sel.log.length})</summary>
          <ol>
            {sel.log.map((d, i) => (
              <li key={i}><span className="mono">{fmtT(d.t)}</span> {d.from !== d.to ? `фаза ${d.from + 1} → ${d.to + 1}: ` : ''}{d.reason}</li>
            ))}
          </ol>
        </details>
      )}

      <details className="sig-src">
        <summary>Источник данных и приближения</summary>
        <p>Светофор стоит здесь, потому что в OpenStreetMap отмечены узлы <code>highway=traffic_signals</code>:{' '}
          {sel.osmSignals.map((id, i) => (
            <span key={id}>{i ? ', ' : ''}<a href={`https://www.openstreetmap.org/node/${id}`} target="_blank" rel="noreferrer">{id}</a></span>
          ))}. Пешеходных переходов рядом в OSM: {sel.crossings.total}, из них регулируемых {sel.crossings.signalized}.</p>
        <p>Подходы и полосы — из дорожного графа OSM. План фаз, длительности и очереди — модель: программы реального светофора в открытых данных нет, к настоящим светофорам и камерам система не подключена.</p>
      </details>

      {sel.mode && (
        <button className="sig-off" onClick={() => ctrl.setSignalActive(sel.index, !working)}>
          {working ? 'Выключить светофор (перекрёсток без регулирования)' : 'Включить светофор'}
        </button>
      )}
    </section>
  );
}

function fmtT(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
