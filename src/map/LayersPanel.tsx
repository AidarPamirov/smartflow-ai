import { useState } from 'react';
import type { TrafficController, TrafficState } from '../traffic/controller';
import { MODE_LABEL } from '../signals/SignalPanel';
import type { ControlMode } from '../signals/runtime';
import { LIGHT_COLOR, MODE_COLOR, STATUS_COLOR, type SignalFilter } from '../signals/signalLayer';
import { CAMERA_COLOR, type CameraFilter } from '../cameras/cameraLayer';
import { TYPE_LABEL } from '../cameras/types';
import { LEVEL_COLOR, LEVEL_LABEL } from '../traffic/congestion';
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
  // на телефоне панель свёрнута, чтобы не закрывать карту
  const [openAtStart] = useState(() => typeof window === 'undefined' || window.innerWidth > 640);

  return (
    <details className="map-panel map-layers" open={openAtStart}>
      <summary>Слои и светофоры</summary>
      <div className="lay-row">
        <label><input type="checkbox" checked={!!sg?.visible} disabled={!ready} onChange={(e) => ctrl?.setSignalsVisible(e.target.checked)} /> Светофоры</label>
        <label><input type="checkbox" checked={!!st?.trafficVisible} disabled={st?.phase !== 'ready'} onChange={(e) => ctrl?.setTrafficVisible(e.target.checked)} /> Машины (демо)</label>
        <label><input type="checkbox" checked={!!st?.cameras.visible} disabled={st?.cameras.phase !== 'ready'} onChange={(e) => ctrl?.setCamerasVisible(e.target.checked)} /> Камеры</label>
        <label><input type="checkbox" checked={!!st?.congestion.visible} disabled={st?.phase !== 'ready'} onChange={(e) => ctrl?.setCongestionVisible(e.target.checked)} /> Загруженность</label>
      </div>
      {st?.congestion.visible && (
        <div className="lay-legend lay-cong">
          {LEVEL_LABEL.map((l, i) => <span key={l}><i className="bar" style={{ background: LEVEL_COLOR[i] }} />{l}{st.congestion.histogram ? <span className="lay-n">{st.congestion.histogram[i]}</span> : null}</span>)}
          <span className="lay-note">доля условной свободной скорости по синтетическим машинам; без машин участок не окрашен</span>
        </div>
      )}
      {st?.cameras.phase === 'error' && <p className="lay-err">Камеры недоступны: {st.cameras.error}.</p>}
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
          {st.cameras.counts && (
            <div className="lay-block">
              <div className="lay-title">Камеры (виртуальные)</div>
              <div className="lay-row">
                {(Object.keys(TYPE_LABEL) as (keyof CameraFilter)[]).map((k) => (
                  <label key={k}>
                    <input type="checkbox" checked={st.cameras.filter[k]} onChange={(e) => ctrl.setCameraFilter({ ...st.cameras.filter, [k]: e.target.checked })} />
                    <i className="lay-cam" style={{ background: k === 'seatbelt' ? 'transparent' : CAMERA_COLOR[k], borderColor: CAMERA_COLOR[k] }} />
                    {TYPE_LABEL[k].replace('Камера ', '')} <span className="lay-n">{st.cameras.counts![k]}</span>
                  </label>
                ))}
              </div>
              <p className="lay-muted">Поток, скорость и линия — по синтетическому трафику; ремень — визуальный макет без модели. Реальных видеопотоков нет.</p>
            </div>
          )}
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
