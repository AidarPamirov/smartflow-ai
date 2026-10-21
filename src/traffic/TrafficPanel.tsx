import { useState } from 'react';
import { COUNTS, SPEEDS, type TrafficController, type TrafficState } from './controller';
import type { DemandMode } from './routing';
import { MIN_ZOOM } from './trafficLayer';

const fmtTime = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const nf = (n: number) => n.toLocaleString('ru-RU');
const DEMAND: [DemandMode, string][] = [['uniform', 'обычный'], ['morning', 'утренний пик'], ['evening', 'вечерний пик']];

/**
 * Панель демо-трафика. Только интерфейс: всю работу делает TrafficController (общий с панелями светофоров).
 */
export function TrafficPanel({ ctrl: c, st, mapReady }: { ctrl: TrafficController | null; st: TrafficState | null; mapReady: boolean }) {
  const [open, setOpen] = useState(true);
  const ready = st?.phase === 'ready';

  return (
    <section className={`map-panel traffic${open ? '' : ' collapsed'}`} aria-label="Демо-трафик">
      <header className="traffic-head">
        <button className="traffic-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Демо-трафик <span className="traffic-badge" title="Синтетические поездки, не реальные данные">синтетика</span>
        </button>
        {st && ready && <span className="traffic-clock" title="Время модели">{fmtTime(st.stats.simTime)}</span>}
      </header>

      {!mapReady && <p className="traffic-msg">Жду загрузку карты…</p>}
      {mapReady && (!st || st.phase === 'waiting' || st.phase === 'loading') && <p className="traffic-msg">Загружаю дорожную сеть…</p>}
      {st?.phase === 'routing' && (
        <p className="traffic-msg">
          Строю маршруты по графу: {st.progress} из {st.poolSize}
          <progress value={st.progress} max={st.poolSize} />
        </p>
      )}
      {st?.phase === 'error' && (
        <div className="traffic-msg traffic-err" role="alert">
          <p>Трафик недоступен: {st.error}. Карта при этом работает.</p>
          <button onClick={() => void c?.init()}>Повторить</button>
        </div>
      )}

      {ready && st && open && (
        <>
          <div className="traffic-row">
            <button className="traffic-play" onClick={() => c?.toggle()} aria-label={st.running ? 'Пауза' : 'Запустить'}>
              {st.running ? '❚❚ Пауза' : '▶ Старт'}
            </button>
            <button onClick={() => c?.reset()} title="Вернуть машины в начальное положение (тот же seed)">↺ Сброс</button>
            <div className="traffic-seg" role="group" aria-label="Скорость симуляции">
              {SPEEDS.map((x) => (
                <button key={x} className={st.speed === x ? 'on' : ''} aria-pressed={st.speed === x} onClick={() => c?.setSpeed(x)}>{x}×</button>
              ))}
            </div>
          </div>
          <div className="traffic-row">
            <span className="traffic-label">Спрос</span>
            <div className="traffic-seg" role="group" aria-label="Сценарий спроса">
              {DEMAND.map(([k, label]) => (
                <button key={k} className={st.demand === k ? 'on' : ''} aria-pressed={st.demand === k} onClick={() => void c?.setDemand(k)}>{label}</button>
              ))}
            </div>
          </div>
          {st.demand !== 'uniform' && (
            <p className="traffic-rush">
              {st.demand === 'morning' ? 'Утро: ' : 'Вечер: '}
              {st.demand === 'morning' ? '¾ поездок едут с окраин и въездов в город в центр' : '¾ поездок едут из центра на окраины и к выездам'}.
              Сравните Baseline и адаптивный режим в панели слоёв. Это синтетический сценарий, а не данные о реальных пробках.
            </p>
          )}
          <div className="traffic-row">
            <label htmlFor="traffic-count">Машин</label>
            <select id="traffic-count" value={st.count} onChange={(e) => c?.setCount(Number(e.target.value))}>
              {COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label className="traffic-check">
              <input type="checkbox" checked={st.networkVisible} onChange={(e) => c?.setNetworkVisible(e.target.checked)} />
              дорожный граф
            </label>
          </div>
          <p className="traffic-stats">
            {st.zoomTooLow
              ? `Приблизьте карту (зум ≥ ${MIN_ZOOM}), чтобы увидеть машины`
              : `на экране ${nf(st.inView)}${st.inView > st.rendered ? ` (показано ${nf(st.rendered)})` : ''}`}
            {' · '}поездок {nf(st.stats.trips)} · ср. скорость в модели {Math.round(st.stats.meanSpeed * 3.6)} км/ч
          </p>
          <details className="traffic-note">
            <summary>Что это за машины?</summary>
            <p>
              Синтетические поездки, не реальные данные о движении. Начало и конец каждой поездки выбираются случайно,
              путь — кратчайший по времени по реальной сети дорог OpenStreetMap
              {st.meta ? ` (центр Бишкека, ${nf(Math.round(st.meta.km))} км дорог, ${nf(st.meta.edges)} участков)` : ''}.
            </p>
            <p>
              Час пик — тоже синтетика: три четверти поездок утром едут из окраин в центр (радиус 2,2 км от площади Ала-Тоо),
              вечером — обратно. 60 % из них начинаются на въездах в город — узлах магистралей у края графа, потому что
              крупные спальные районы и пригороды лежат за его пределами. Доехав, машина «паркуется», а на окраине выезжает новая.
              Реальных данных о трафике Бишкека в открытом доступе нет, поэтому совпадение с конкретными пробками не гарантировано.
            </p>
            <p>
              На перекрёстках, где в OpenStreetMap отмечен светофор, машины останавливаются на красный виртуального
              светофора. Правил приоритета между направлениями и перестроений нет. Скорости — условные для каждого класса дороги.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
