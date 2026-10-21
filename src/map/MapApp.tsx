import { useCallback, useEffect, useRef, useState } from 'react';
import { Map as MlMap, ScaleControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { TrafficPanel } from '../traffic/TrafficPanel';
import { useCity } from '../traffic/useCity';
import { SignalPanel } from '../signals/SignalPanel';
import { CameraPanel } from '../cameras/CameraPanel';
import { LayersPanel } from './LayersPanel';
import { ATTRIBUTION, BISHKEK, DEFAULT_BUILDING_HEIGHT, LEVEL_HEIGHT, buildStyle, buildingVisibility, type MapMode } from './style';

type Status = 'loading' | 'ready' | 'error';

interface View { zoom: number; pitch: number; bearing: number; lng: number; lat: number }

const PITCH_3D = BISHKEK.pitch;
const ROTATE_STEP = 30;

const fmt = (n: number, d = 0) => n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Цифровой двойник: 3D-карта Бишкека (этап 1), синтетический демо-трафик (этап 2, src/traffic)
 * и виртуальные светофоры на перекрёстках, где светофор есть в OSM (этап 4, src/signals).
 * Карта не зависит от трафика и светофоров: при ошибке их загрузки она продолжает работать.
 */
export default function MapApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const modeRef = useRef<MapMode>('3d');
  const [status, setStatus] = useState<Status>('loading');
  /** Карта создана: камерой можно управлять даже до загрузки данных. */
  const [mapObj, setMapObj] = useState<MlMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Были ошибки загрузки: заставку больше не показываем, даже если баннер скрыт. */
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<MapMode>('3d');
  const [view, setView] = useState<View>({
    zoom: BISHKEK.zoom, pitch: BISHKEK.pitch, bearing: BISHKEK.bearing, lng: BISHKEK.center[0], lat: BISHKEK.center[1],
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let map: MlMap;
    try {
      map = new MlMap({
        container: el,
        style: buildStyle(),
        center: BISHKEK.center,
        zoom: BISHKEK.zoom,
        pitch: BISHKEK.pitch,
        bearing: BISHKEK.bearing,
        maxBounds: BISHKEK.maxBounds,
        minZoom: BISHKEK.minZoom,
        maxZoom: BISHKEK.maxZoom,
        maxPitch: BISHKEK.maxPitch,
        // Атрибуция задана явно, чтобы она была видна всегда, даже если данные ещё не загрузились.
        attributionControl: { compact: false, customAttribution: ATTRIBUTION },
        antialias: true,
      });
    } catch (e) {
      setStatus('error');
      setError(
        'Не удалось запустить 3D-карту: браузеру нужен WebGL. Включите аппаратное ускорение в настройках браузера или откройте страницу в другом браузере.' +
          (e instanceof Error ? ` (${e.message})` : ''),
      );
      return;
    }
    mapRef.current = map;
    setMapObj(map);
    map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    let raf = 0;
    const sync = () => {
      raf = 0;
      const c = map.getCenter();
      setView({ zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), lng: c.lng, lat: c.lat });
    };
    map.on('move', () => { if (!raf) raf = requestAnimationFrame(sync); });
    // Флаг первой загрузки: map.loaded() позже бывает false из-за обновляемого слоя трафика — это не ошибка.
    let loadedOnce = false;
    map.on('load', () => { loadedOnce = true; setStatus((s) => (s === 'error' ? s : 'ready')); });
    const slow = window.setTimeout(() => {
      if (loadedOnce) return;
      setFailed(true);
      setError((prev) => prev ?? 'Карта загружается дольше обычного. Проверьте подключение к интернету или обновите страницу.');
    }, 20000);
    map.on('error', (ev) => {
      setFailed(true);
      // Ошибки сети и тайлов: показываем один понятный баннер, карта продолжает работать с тем, что загрузилось.
      const msg = ev.error instanceof Error ? ev.error.message : String(ev.error ?? '');
      setError((prev) =>
        prev ??
          `Часть данных карты не загрузилась с tiles.openfreemap.org. Проверьте подключение к интернету и обновите страницу.${msg ? ` (${msg})` : ''}`,
      );
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(slow);
      map.remove();
      mapRef.current = null;
      setMapObj(null);
    };
  }, []);

  /** Переключение 3D / план: видимость слоёв зданий, наклон и вращение. */
  const applyMode = useCallback((next: MapMode) => {
    modeRef.current = next;
    setMode(next);
    const map = mapRef.current;
    if (!map) return;
    const vis = buildingVisibility(next);
    if (map.getLayer('building-3d')) map.setLayoutProperty('building-3d', 'visibility', vis.extruded);
    if (map.getLayer('building-flat')) map.setLayoutProperty('building-flat', 'visibility', vis.flat);
    if (next === '2d') {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
      map.once('moveend', () => { if (modeRef.current === '2d') map.setMaxPitch(0); });
    } else {
      map.setMaxPitch(BISHKEK.maxPitch);
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.keyboard.enableRotation();
      map.easeTo({ pitch: PITCH_3D, bearing: map.getBearing() === 0 ? BISHKEK.bearing : map.getBearing(), duration: 700 });
    }
  }, []);

  // Видимость слоёв задаётся и после загрузки стиля (если режим переключили до неё).
  useEffect(() => {
    const map = mapRef.current;
    if (status !== 'ready' || !map) return;
    const vis = buildingVisibility(modeRef.current);
    map.setLayoutProperty('building-3d', 'visibility', vis.extruded);
    map.setLayoutProperty('building-flat', 'visibility', vis.flat);
  }, [status]);

  const zoomBy = (d: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (d > 0) map.zoomIn({ duration: 300 }); else map.zoomOut({ duration: 300 });
  };
  const rotateBy = (deg: number) => mapRef.current?.easeTo({ bearing: (mapRef.current?.getBearing() ?? 0) + deg, duration: 400 });
  const resetNorth = () => mapRef.current?.easeTo({ bearing: 0, duration: 400 });
  const resetView = () => {
    const is3d = modeRef.current === '3d';
    mapRef.current?.flyTo({
      center: BISHKEK.center, zoom: BISHKEK.zoom, pitch: is3d ? PITCH_3D : 0, bearing: is3d ? BISHKEK.bearing : 0, duration: 1600,
    });
  };

  const disabled = !mapObj;
  const { ctrl, st } = useCity(mapObj, status === 'ready');
  const selected = st?.signals.selected ?? null;
  const selectedCam = st?.cameras.selected ?? null;

  // ссылка на светофор: #signal=tls-…
  const signalsReady = st?.signals.phase === 'ready';
  useEffect(() => {
    if (!signalsReady || !ctrl) return;
    const go = () => {
      const m = /^#(signal|camera)=([\w-]+)$/.exec(location.hash);
      if (m?.[1] === 'signal') ctrl.selectSignalById(m[2]);
      if (m?.[1] === 'camera') ctrl.selectCameraById(m[2]);
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [signalsReady, ctrl]);

  const anySelected = !!(selected || selectedCam);
  useEffect(() => {
    if (!anySelected || !ctrl) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { ctrl.selectSignal(null); ctrl.selectCamera(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anySelected, ctrl]);

  return (
    <div className={`map-root${anySelected ? ' has-sel' : ''}`}>
      <div ref={containerRef} className="map-canvas" aria-label="Интерактивная карта Бишкека" />

      <header className="map-panel map-head">
        <div className="map-brand">
          <span className="map-logo" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <h1>SmartFlow AI</h1>
            <p>Бишкек · цифровой двойник дорожной сети</p>
          </div>
        </div>
        <span className="map-stage">Этап 4 · светофоры и камеры</span>
      </header>

      <nav className="map-panel map-controls" aria-label="Управление картой">
        <div className="map-seg" role="group" aria-label="Режим карты">
          <button className={mode === '3d' ? 'on' : ''} aria-pressed={mode === '3d'} onClick={() => applyMode('3d')} disabled={disabled}>3D</button>
          <button className={mode === '2d' ? 'on' : ''} aria-pressed={mode === '2d'} onClick={() => applyMode('2d')} disabled={disabled}>План</button>
        </div>
        <div className="map-group">
          <button onClick={() => zoomBy(1)} disabled={disabled} aria-label="Приблизить" title="Приблизить">+</button>
          <button onClick={() => zoomBy(-1)} disabled={disabled} aria-label="Отдалить" title="Отдалить">−</button>
        </div>
        {mode === '3d' && (
          <div className="map-group">
            <button onClick={() => rotateBy(-ROTATE_STEP)} disabled={disabled} aria-label="Повернуть против часовой стрелки" title="Повернуть на 30° влево">⟲</button>
            <button onClick={() => rotateBy(ROTATE_STEP)} disabled={disabled} aria-label="Повернуть по часовой стрелке" title="Повернуть на 30° вправо">⟳</button>
          </div>
        )}
        <div className="map-group">
          <button onClick={resetNorth} disabled={disabled || mode === '2d'} aria-label="Повернуть на север" title="На север">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ transform: `rotate(${-view.bearing}deg)` }}>
              <path d="M9 2 12 9H6Z" fill="var(--map-accent)" />
              <path d="M9 16 6 9h6Z" fill="currentColor" opacity=".55" />
            </svg>
          </button>
          <button onClick={resetView} disabled={disabled} aria-label="Вернуться к центру Бишкека" title="К центру (площадь Ала-Тоо)">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="9" cy="9" r="1.8" fill="currentColor" />
              <path d="M9 0v3M9 15v3M0 9h3M15 9h3" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </div>
      </nav>

      <div className="map-panel map-readout" aria-live="off">
        <span>z {fmt(view.zoom, 1)}</span>
        <span>наклон {fmt(view.pitch)}°</span>
        <span>азимут {fmt(((view.bearing % 360) + 360) % 360)}°</span>
        <span className="map-coord">{view.lat.toFixed(4)}° N, {view.lng.toFixed(4)}° E</span>
      </div>

      <div className="map-side">
      <details className="map-panel map-info">
        <summary>О данных</summary>
        <p><b>Карта:</b> улицы, вода, зелень и контуры зданий из OpenStreetMap, векторные тайлы OpenFreeMap (схема OpenMapTiles).</p>
        <p><b>Высота зданий:</b> из OSM — тег <code>height</code> или этажность × {fmt(LEVEL_HEIGHT, 2)} м. Если данных нет, здание показано условно низким ({DEFAULT_BUILDING_HEIGHT} м).</p>
        <p><b>Трафик:</b> синтетический демонстрационный слой — случайные поездки по реальной сети дорог OSM. Это не данные о реальном движении.</p>
        <p><b>Светофоры:</b> стоят только там, где светофор отмечен в OSM. Фазы и очереди — модель, а не данные городских систем: к реальным светофорам и камерам проект не подключён.</p>
        <p><b>Камеры:</b> виртуальные, расставлены по правилам модели. Считают по синтетическому трафику; камера ремня — только макет.</p>
        <p className="map-hint">Вращение и наклон: правая кнопка мыши или Ctrl + перетаскивание; на телефоне — двумя пальцами.</p>
        <a className="map-link" href="#lab">Лаборатория перекрёстка →</a>
        <a className="map-link" href="#sumo">Эксперимент SUMO: перекрёсток Чуй × Манаса →</a>
        <a className="map-link" href="#cv">Компьютерное зрение: проверка модулей →</a>
      </details>
      <LayersPanel ctrl={ctrl} st={st} />
      </div>

      {selected && ctrl && <SignalPanel ctrl={ctrl} sel={selected} />}
      {selectedCam && ctrl && <CameraPanel ctrl={ctrl} sel={selectedCam} />}

      <TrafficPanel ctrl={ctrl} st={st} mapReady={status === 'ready'} />

      {status === 'loading' && !failed && (
        <div className="map-overlay" role="status"><span className="map-spinner" aria-hidden="true" />Загружаю карту Бишкека…</div>
      )}
      {error && (
        <div className="map-panel map-error" role="alert">
          <p>{error}</p>
          <div className="map-error-actions">
            <button onClick={() => location.reload()}>Обновить страницу</button>
            {status !== 'error' && <button onClick={() => setError(null)}>Скрыть</button>}
          </div>
        </div>
      )}
    </div>
  );
}
