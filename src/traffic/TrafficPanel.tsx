import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { COUNTS, SPEEDS, TrafficController, type TrafficState } from './controller';
import { MIN_ZOOM } from './trafficLayer';

const NETWORK_URL = `${import.meta.env.BASE_URL}data/bishkek-roads.json`;

const fmtTime = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const nf = (n: number) => n.toLocaleString('ru-RU');

/**
 * Панель демо-трафика. Только интерфейс: всю работу делает TrafficController.
 * Подключается после загрузки стиля карты (mapReady).
 */
export function TrafficPanel({ map, mapReady }: { map: MlMap | null; mapReady: boolean }) {
  const ctrl = useRef<TrafficController | null>(null);
  const [st, setSt] = useState<TrafficState | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!map || !mapReady) return;
    const c = new TrafficController(map, NETWORK_URL, setSt);
    ctrl.current = c;
    void c.init();
    return () => { c.destroy(); ctrl.current = null; };
  }, [map, mapReady]);

  const c = ctrl.current;
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
              Светофоры, правила приоритета и перестроения не моделируются: на перекрёстках машины не уступают друг другу.
              Скорости — условные для каждого класса дороги.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
