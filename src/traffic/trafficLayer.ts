/**
 * Отрисовка демо-трафика на карте MapLibre. Только визуализация: получает готовые положения машин
 * и ничего не знает о маршрутах и модели движения.
 *
 * Производительность:
 *  - в источник попадают только машины в пределах экрана (с запасом), не больше MAX_RENDERED;
 *  - на мелком масштабе (зум < MIN_ZOOM) слой пустой и обновления пропускаются;
 *  - частоту обновления ограничивает вызывающий код (TrafficPanel), около 30 раз в секунду.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { VehiclePose } from './fleet';
import { networkToGeoJSON, toLonLat, type Network } from './network';

export const MIN_ZOOM = 12;
export const MAX_RENDERED = 800;
/** С этого зума машины рисуются ориентированными силуэтами, ниже — точками. */
export const CAR_ZOOM = 16.5;

const SRC_TRAFFIC = 'sf-traffic';
const SRC_NETWORK = 'sf-network';
const L_NETWORK = 'sf-network-lines';
const L_DOTS = 'sf-traffic-dots';
const L_CARS = 'sf-traffic-cars';
const IMG_CAR = 'sf-car';
/** Слои трафика вставляются под здания и подписи, но над дорогами. */
const BEFORE = 'building-flat';

export const TRAFFIC_COLOR = '#ffc35c';
const NETWORK_COLOR = '#6fb6ff';

interface PointFeature { type: 'Feature'; properties: { h: number }; geometry: { type: 'Point'; coordinates: [number, number] } }
const EMPTY = { type: 'FeatureCollection' as const, features: [] as PointFeature[] };

/** Силуэт машины сверху, носом вверх (на север при азимуте 0). */
function carImage(): ImageData {
  const w = 20, h = 40; // при pixelRatio 2 — 10 × 20 CSS-пикселей
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = TRAFFIC_COLOR;
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(1, 1, w - 2, h - 2, 6);
  else g.rect(1, 1, w - 2, h - 2); // старые браузеры без roundRect
  g.fill();
  g.fillStyle = 'rgba(15, 20, 27, 0.55)'; // лобовое и заднее стекло
  g.fillRect(4, 9, w - 8, 6);
  g.fillRect(4, h - 11, w - 8, 4);
  return g.getImageData(0, 0, w, h);
}

export class TrafficLayer {
  private attached = false;
  private empty = true;

  constructor(private map: MlMap, private net: Network) {}

  attach() {
    const map = this.map;
    if (this.attached) return;
    const before = map.getLayer(BEFORE) ? BEFORE : undefined;
    if (!map.hasImage(IMG_CAR)) map.addImage(IMG_CAR, carImage(), { pixelRatio: 2 });
    map.addSource(SRC_NETWORK, { type: 'geojson', data: networkToGeoJSON(this.net) });
    map.addSource(SRC_TRAFFIC, { type: 'geojson', data: EMPTY, maxzoom: 15, buffer: 0, tolerance: 0 });
    map.addLayer({
      id: L_NETWORK, type: 'line', source: SRC_NETWORK, layout: { visibility: 'none', 'line-cap': 'round' },
      paint: { 'line-color': NETWORK_COLOR, 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 3] },
    }, before);
    map.addLayer({
      id: L_DOTS, type: 'circle', source: SRC_TRAFFIC, minzoom: MIN_ZOOM, maxzoom: CAR_ZOOM,
      paint: {
        'circle-color': TRAFFIC_COLOR,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 1.8, 15, 3, CAR_ZOOM, 3.8],
        'circle-stroke-color': '#0f141b',
        'circle-stroke-width': 0.6,
        'circle-pitch-alignment': 'map',
      },
    }, before);
    map.addLayer({
      id: L_CARS, type: 'symbol', source: SRC_TRAFFIC, minzoom: CAR_ZOOM,
      layout: {
        'icon-image': IMG_CAR,
        'icon-rotate': ['get', 'h'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Силуэт примерно в 1,4 раза крупнее реальной машины (4,6 м), иначе его плохо видно на тёмной карте.
        'icon-size': ['interpolate', ['exponential', 2], ['zoom'], CAR_ZOOM, 0.6, 18, 0.75, 20, 3],
      },
    }, before);
    this.attached = true;
  }

  get isAttached() { return this.attached; }

  setNetworkVisible(visible: boolean) {
    if (this.attached && this.map.getLayer(L_NETWORK)) this.map.setLayoutProperty(L_NETWORK, 'visibility', visible ? 'visible' : 'none');
  }

  /** Обновляет слой. Возвращает число машин, отправленных на отрисовку. */
  update(poses: Iterable<VehiclePose>): { rendered: number; inView: number } {
    if (!this.attached) return { rendered: 0, inView: 0 };
    const src = this.map.getSource(SRC_TRAFFIC) as GeoJSONSource | undefined;
    if (!src) return { rendered: 0, inView: 0 };
    if (this.map.getZoom() < MIN_ZOOM) {
      if (!this.empty) { src.setData(EMPTY); this.empty = true; }
      return { rendered: 0, inView: 0 };
    }
    const b = this.map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.1, padY = (b.getNorth() - b.getSouth()) * 0.1;
    const w = b.getWest() - padX, e = b.getEast() + padX, s = b.getSouth() - padY, n = b.getNorth() + padY;
    const features: PointFeature[] = [];
    let inView = 0;
    for (const p of poses) {
      const [lon, lat] = toLonLat(this.net.proj, p.x, p.y);
      if (lon < w || lon > e || lat < s || lat > n) continue;
      inView++;
      if (features.length < MAX_RENDERED)
        features.push({ type: 'Feature', properties: { h: Math.round(p.heading) }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    src.setData({ type: 'FeatureCollection', features });
    this.empty = features.length === 0;
    return { rendered: features.length, inView };
  }

  detach() {
    if (!this.attached) return;
    const map = this.map;
    try {
      for (const id of [L_CARS, L_DOTS, L_NETWORK]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [SRC_TRAFFIC, SRC_NETWORK]) if (map.getSource(id)) map.removeSource(id);
      if (map.hasImage(IMG_CAR)) map.removeImage(IMG_CAR);
    } catch {
      // карта уже уничтожена — снимать нечего
    }
    this.attached = false;
  }
}
