import type { SelectedCamera, TrafficController } from '../traffic/controller';
import { CAMERA_COLOR } from './cameraLayer';
import { CONN_LABEL, EVENT_NOTE, MODE_LABEL, TYPE_LABEL } from './types';

const n1 = (x: number | null, unit = '', d = 1) => (x === null ? '—' : `${x.toLocaleString('ru-RU', { maximumFractionDigits: d })}${unit ? ` ${unit}` : ''}`);
const fmtT = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const DIRS = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
const toward = (h: number) => DIRS[Math.round((((h % 360) + 360) % 360) / 45) % 8];

const SENS: Record<SelectedCamera['camera']['type'], { label: string; min: number; max: number; step: number; unit: string } | null> = {
  flow: { label: 'Порог затора: средняя скорость ниже', min: 5, max: 40, step: 1, unit: 'км/ч' },
  speed: { label: 'Допуск над ограничением', min: 0, max: 20, step: 1, unit: 'км/ч' },
  line: { label: 'Минимальный заезд за линию', min: 0.1, max: 2, step: 0.1, unit: 'м' },
  seatbelt: null,
};

/** Панель выбранной камеры: тип, источник данных, метрики, события, настройки. Только отображение и команды. */
export function CameraPanel({ ctrl, sel }: { ctrl: TrafficController; sel: SelectedCamera }) {
  const c = sel.camera;
  const m = sel.metrics;
  const sens = SENS[c.type];
  const synthetic = c.dataMode === 'synthetic';
  return (
    <section className="map-panel sig-panel cam-panel" aria-label={`${TYPE_LABEL[c.type]} ${c.id}`}>
      <header className="sig-head">
        <div>
          <h2><i className="cam-dot" style={{ background: c.dataMode === 'mock' ? 'transparent' : CAMERA_COLOR[c.type], borderColor: CAMERA_COLOR[c.type] }} />{TYPE_LABEL[c.type]}</h2>
          <p className="sig-sub">
            <span className="mono sig-muted">{c.id}</span>
            <span className={`sig-st sig-st-${sel.status === 'online' ? 'working' : 'inactive'}`}>{c.settings.enabled ? CONN_LABEL[sel.status] : 'выключена'}</span>
            <span className={`dq ${c.dataMode === 'mock' ? 'dq-na' : 'dq-synth'}`}>{MODE_LABEL[c.dataMode]}</span>
          </p>
        </div>
        <div className="sig-head-actions">
          <button onClick={() => ctrl.flyToCamera(sel.index)} title="Показать на карте">◎</button>
          <button onClick={() => ctrl.selectCamera(null)} aria-label="Закрыть">✕</button>
        </div>
      </header>

      <p className="sig-hint">
        Виртуальная камера модели: в Бишкеке на этом месте может и не быть камеры, к реальным камерам система не подключена.
        Контролирует {c.street || 'участок без названия'}, смотрит на {toward(c.heading)} ({c.heading}°) вдоль движения.
        {sel.signalId && <> Въезд к светофору <a href={`#signal=${sel.signalId}`}>{sel.signalId}</a>.</>}
      </p>

      {c.type === 'flow' && (
        <dl className="cam-metrics">
          <dt>Поток</dt><dd>{n1(m.flowVehH, 'авт/ч', 0)}</dd>
          <dt>Средняя скорость у линии</dt><dd>{n1(m.meanSpeedKmh, 'км/ч')}</dd>
          <dt>Плотность (100 м перед линией)</dt><dd>{n1(m.densityVehKm, 'авт/км')}</dd>
          <dt>Занятость зоны детектора</dt><dd>{m.occupancy === null ? '—' : `${Math.round(m.occupancy * 100)} %`}</dd>
          <dt>Очередь у светофора</dt><dd>{m.queue === null ? 'недоступно' : `${m.queue} авт`}</dd>
          <dt>Состояние</dt><dd className={m.congested ? 'cam-bad' : ''}>{sel.status !== 'online' ? '—' : m.congested ? 'затор' : 'без затора'}</dd>
        </dl>
      )}
      {c.type === 'speed' && (
        <dl className="cam-metrics">
          <dt>Метод</dt><dd>время между двумя линиями, участок {Math.round(c.marks[1] - c.marks[0])} м</dd>
          <dt>Ограничение (демо)</dt><dd>{c.limitKmh} км/ч + допуск {c.settings.sensitivity}</dd>
          <dt>Замеров</dt><dd>{m.measured}</dd>
          <dt>Средняя / 85 % / макс.</dt><dd>{n1(m.meanKmh)} / {n1(m.p85Kmh)} / {n1(m.maxKmh, 'км/ч')}</dd>
          <dt>Превышений всего</dt><dd>{m.violations}</dd>
        </dl>
      )}
      {c.type === 'line' && (
        <dl className="cam-metrics">
          <dt>Линия</dt><dd>ось дороги на последних {Math.round(c.marks[1] - c.marks[0])} м до стоп-линии, в координатах дороги</dd>
          <dt>Пересечений всего</dt><dd>{m.crossings}</dd>
        </dl>
      )}
      {c.type === 'seatbelt' && (
        <dl className="cam-metrics">
          <dt>Модель распознавания</dt><dd className="cam-bad">не подключена</dd>
          <dt>Результат</dt><dd>невозможно определить</dd>
          <dt>Проехало мимо</dt><dd>{m.passes}</dd>
        </dl>
      )}
      {c.type === 'seatbelt' && (
        <p className="sig-hint">
          Это визуальный макет. Для оценки ремня нужна отдельная модель, обученная на изображениях салона через стекло, и датасет
          с разметкой. Без неё система не делает выводов: блики, стойки, одежда и низкое разрешение дают «невозможно определить».
        </p>
      )}
      {c.type === 'line' && synthetic && m.crossings === 0 && (
        <p className="sig-hint">В синтетическом трафике нет перестроений и выездов на встречную, поэтому событий нет. Детектор проверен тестами на заданных траекториях.</p>
      )}
      {synthetic && <p className="sig-hint">Окно метрик — {m.windowS} с времени модели. Данные: синтетический трафик, положения машин — от симулятора.</p>}

      {c.type !== 'seatbelt' && (
        <details className="sig-log" open={sel.events.length > 0}>
          <summary>События: {sel.totalEvents}</summary>
          {sel.events.length > 0 ? (
            <ol>
              {sel.events.map((e, i) => (
                <li key={i} className={e.kind === 'insufficient_data' ? 'cam-weak' : ''}>
                  <span className="mono">{fmtT(e.t)}</span> {e.vehicle && <span className="mono">{e.vehicle}</span>} {e.text}
                  {e.kind !== 'congestion_end' && <span className="sig-muted"> · уверенность {Math.round(e.confidence * 100)} %</span>}
                </li>
              ))}
            </ol>
          ) : <p className="sig-muted">пока нет</p>}
          <p className="sig-muted">{EVENT_NOTE} Машины обозначены анонимно, номера и изображения не сохраняются.</p>
        </details>
      )}

      <div className="cam-settings">
        <label className="cam-check"><input type="checkbox" checked={c.settings.enabled} onChange={(e) => ctrl.setCameraSettings(sel.index, { enabled: e.target.checked })} /> камера включена</label>
        {sens && (
          <label>
            {sens.label}: <b>{c.settings.sensitivity.toLocaleString('ru-RU')} {sens.unit}</b>
            <input type="range" min={sens.min} max={sens.max} step={sens.step} value={c.settings.sensitivity} onChange={(e) => ctrl.setCameraSettings(sel.index, { sensitivity: Number(e.target.value) })} />
          </label>
        )}
        <label>
          Порог уверенности: <b>{Math.round(c.settings.confidenceThreshold * 100)} %</b>
          <input type="range" min={0.5} max={0.99} step={0.01} value={c.settings.confidenceThreshold} onChange={(e) => ctrl.setCameraSettings(sel.index, { confidenceThreshold: Number(e.target.value) })} />
        </label>
      </div>
    </section>
  );
}
