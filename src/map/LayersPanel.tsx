import type { TrafficController, TrafficState } from '../traffic/controller';
import { MODE_LABEL } from '../signals/SignalPanel';
import type { ControlMode } from '../signals/runtime';
import { LIGHT_COLOR, MODE_COLOR, STATUS_COLOR, type SignalFilter } from '../signals/signalLayer';
import type { ItemStatus } from '../signals/system';

const STATUS_NAME: Record<ItemStatus, string> = { working: 'работает', inactive: 'выключен', no_data: 'нет данных' };
const nf = (n: number) => n.toLocaleString('ru-RU');

/** Слои карты, фильтры светофоров, общий режим Baseline / Adaptive AI и легенда. */
export function LayersPanel({ ctrl, st }: { ctrl: TrafficController | null; st: TrafficState | null }) {
  const sg = st?.signals;
  const ready = sg?.phase === 'ready' && ctrl;
  const f = sg?.filter;
  const c = sg?.counts;
  const allMode: ControlMode | null = c ? (c.adaptive === c.working + c.inactive && c.adaptive > 0 ? 'adaptive' : c.fixed === c.working + c.inactive ? 'fixed' : null) : null;
  const setF = (patch: (f: SignalFilter) => SignalFilter) => { if (ctrl && f) ctrl.setSignalFilter(patch(f)); };

  return (
    <details className="map-panel map-layers" open>
      <summary>Слои и светофоры</summary>
      <div className="lay-row">
        <label><input type="checkbox" checked={!!sg?.visible} disabled={!ready} onChange={(e) => ctrl?.setSignalsVisible(e.target.checked)} /> Светофоры</label>
        <label><input type="checkbox" checked={!!st?.trafficVisible} disabled={st?.phase !== 'ready'} onChange={(e) => ctrl?.setTrafficVisible(e.target.checked)} /> Машины (демо)</label>
      </div>
      {sg?.phase === 'loading' && <p className="lay-muted">Загружаю светофоры из OSM…</p>}
      {sg?.phase === 'error' && <p className="lay-err">Светофоры недоступны: {sg.error}. Трафик едет без регулирования.</p>}
      {ready && c && f && sg.stats && (
        <>
          <div className="lay-block">
            <div className="lay-title">Управление всеми светофорами</div>
            <div className="lay-seg" role="group" aria-label="Режим всех светофоров">
              {(['fixed', 'adaptive'] as ControlMode[]).map((m) => (
                <button key={m} className={allMode === m ? 'on' : ''} aria-pressed={allMode === m} onClick={() => ctrl.setAllSignalModes(m)}>{MODE_LABEL[m]}</button>
              ))}
            </div>
            <p className="lay-muted">Adaptive AI — правила по очередям и ожиданию, без машинного обучения. В городском слое очереди синтетические; доказательное сравнение — в <a href="#sumo">эксперименте SUMO</a>.</p>
          </div>
          <div className="lay-block">
            <div className="lay-title">Фильтр</div>
            <div className="lay-row">
              {(Object.keys(STATUS_NAME) as ItemStatus[]).map((k) => (
                <label key={k}><input type="checkbox" checked={f.status[k]} onChange={(e) => setF((x) => ({ ...x, status: { ...x.status, [k]: e.target.checked } }))} /> {STATUS_NAME[k]} <span className="lay-n">{nf(c[k])}</span></label>
              ))}
            </div>
            <div className="lay-row">
              {(['fixed', 'adaptive', 'manual'] as ControlMode[]).map((k) => (
                <label key={k}><input type="checkbox" checked={f.mode[k]} onChange={(e) => setF((x) => ({ ...x, mode: { ...x.mode, [k]: e.target.checked } }))} /> {MODE_LABEL[k]} <span className="lay-n">{nf(c[k])}</span></label>
              ))}
            </div>
          </div>
          <div className="lay-block lay-legend">
            <div className="lay-title">Легенда</div>
            <span><i style={{ background: MODE_COLOR.fixed }} />Baseline</span>
            <span><i style={{ background: MODE_COLOR.adaptive }} />Adaptive AI</span>
            <span><i style={{ background: MODE_COLOR.manual }} />ручной</span>
            <span><i style={{ background: STATUS_COLOR.inactive }} />выключен</span>
            <span><i className="ring" />нет данных</span>
            <span><i style={{ background: LIGHT_COLOR.G }} /><i style={{ background: LIGHT_COLOR.Y }} /><i style={{ background: LIGHT_COLOR.R }} />сигнал въезда (зум ≥ 15)</span>
            <span><i className="osm" />узел светофора в OSM — факт (зум ≥ 16)</span>
          </div>
          <p className="lay-muted">
            {nf(c.working + c.inactive + c.no_data)} светофорных объектов из {nf(sg.stats.osmSignals)} узлов OSM
            (ещё {nf(sg.stats.standalone)} — пешеходные или на улицах вне графа). Данные OSM на {sg.osmBase?.slice(0, 10) ?? '—'}.
            Нажмите на светофор, чтобы открыть его панель.
          </p>
        </>
      )}
    </details>
  );
}
