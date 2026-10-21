/**
 * Слой светофоров на карте MapLibre. Только отрисовка: состояние берётся из SignalSystem.
 *
 *  - «объекты»: по точке на светофорный объект, источник с кластеризацией (на мелком масштабе — кружки с числом);
 *  - «сигналы»: на крупном масштабе (зум ≥ HEADS_ZOOM) — цветная точка на каждом въезде, только в пределах экрана;
 *  - «узлы OSM»: факты из OpenStreetMap (узлы highway=traffic_signals) — мелкие белые точки на зуме ≥ OSM_ZOOM,
 *    чтобы было видно, где данные, а где виртуальная модель.
 * Ни одного React-компонента на объект: всё — GeoJSON-источники, обновляемые пачкой несколько раз в секунду.
 */
import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl';
import type { RawOsmSignals } from './inventory';
import type { ControlMode, Light } from './runtime';
import { SignalSystem, type ItemStatus, type SignalItem } from './system';

export const HEADS_ZOOM = 15;
export const OSM_ZOOM = 16;
const SRC_SITES = 'sf-signals';
const SRC_HEADS = 'sf-signal-heads';
const SRC_OSM = 'sf-signal-osm';
const L_CLUSTER = 'sf-signals-cluster';
const L_COUNT = 'sf-signals-count';
const L_SITE = 'sf-signals-site';
const L_SEL = 'sf-signals-selected';
const L_HEADS = 'sf-signal-heads';
const L_OSM = 'sf-signal-osm';
const BEFORE = 'street-names';

export const MODE_COLOR: Record<ControlMode, string> = { fixed: '#6fb6ff', adaptive: '#3ddc97', manual: '#ffb347' };
export const STATUS_COLOR: Record<ItemStatus, string> = { working: '#6fb6ff', inactive: '#8d9bb0', no_data: '#8d9bb0' };
export const LIGHT_COLOR: Record<Light, string> = { G: '#2fd17c', Y: '#ffc533', R: '#ff5a52', off: '#5b6675' };

export interface SignalFilter {
  status: Record<ItemStatus, boolean>;
  mode: Record<ControlMode, boolean>;
}
export const ALL_SIGNALS: SignalFilter = {
  status: { working: true, inactive: true, no_data: true },
  mode: { fixed: true, adaptive: true, manual: true },
};

export function passes(sys: SignalSystem, it: SignalItem, f: SignalFilter): boolean {
  const st = sys.status(it);
  if (!f.status[st]) return false;
  if (it.rt && !f.mode[it.rt.mode]) return false;
  return true;
}

type Pt = { type: 'Feature'; properties: Record<string, string | number>; geometry: { type: 'Point'; coordinates: [number, number] } };
const fc = (features: Pt[]) => ({ type: 'FeatureCollection' as const, features });

/** Объекты для источника с кластеризацией. */
export function sitesGeoJSON(sys: SignalSystem, f: SignalFilter) {
  return fc(sys.items.filter((it) => passes(sys, it, f)).map((it) => ({
    type: 'Feature',
    properties: { i: it.index, st: sys.status(it), m: it.rt?.mode ?? 'none', z: it.zone ? 1 : 0 },
    geometry: { type: 'Point', coordinates: [it.site.lon, it.site.lat] },
  })));
}

const M_LON = 1 / 81_600, M_LAT = 1 / 111_200; // градусов на метр на широте Бишкека

/** Сигналы въездов: точка на подходе в стороне от центра объекта. Только объекты в рамке bbox. */
export function headsGeoJSON(sys: SignalSystem, f: SignalFilter, bbox: [number, number, number, number]) {
  const [w, s, e, n] = bbox;
  const out: Pt[] = [];
  for (const it of sys.items) {
    const { lon, lat } = it.site;
    if (lon < w || lon > e || lat < s || lat > n || !it.rt || !passes(sys, it, f)) continue;
    const r = Math.min(45, Math.max(16, it.site.diameter / 2 + 12));
    it.site.legs.forEach((leg, li) => {
      const light = sys.legLight(it, li);
      if (!light) return;
      const b = (leg.bearing * Math.PI) / 180;
      out.push({
        type: 'Feature',
        properties: { c: light, i: it.index },
        geometry: { type: 'Point', coordinates: [lon + Math.sin(b) * r * M_LON, lat + Math.cos(b) * r * M_LAT] },
      });
    });
  }
  return fc(out);
}

export function osmGeoJSON(osm: RawOsmSignals) {
  return fc(osm.signals.map((s) => ({ type: 'Feature', properties: { id: s.id }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })));
}

export class SignalLayer {
  private attached = false;
  private filter: SignalFilter = ALL_SIGNALS;
  private onClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (f) this.onSelect(Number(f.properties?.i));
  };
  private onClusterClick = async (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    const src = this.map.getSource(SRC_SITES) as GeoJSONSource | undefined;
    if (!f || !src) return;
    const zoom = await src.getClusterExpansionZoom(Number(f.properties?.cluster_id));
    this.map.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: Math.min(zoom + 0.2, 18), duration: 500 });
  };
  private pointer = () => { this.map.getCanvas().style.cursor = 'pointer'; };
  private unpointer = () => { this.map.getCanvas().style.cursor = ''; };

  constructor(private map: MlMap, private sys: SignalSystem, private osm: RawOsmSignals, private onSelect: (i: number) => void) {}

  attach() {
    if (this.attached) return;
    const map = this.map;
    const before = map.getLayer(BEFORE) ? BEFORE : undefined;
    map.addSource(SRC_SITES, { type: 'geojson', data: sitesGeoJSON(this.sys, this.filter), cluster: true, clusterMaxZoom: 13, clusterRadius: 36 });
    map.addSource(SRC_HEADS, { type: 'geojson', data: fc([]) });
    map.addSource(SRC_OSM, { type: 'geojson', data: osmGeoJSON(this.osm) });
    map.addLayer({
      id: L_CLUSTER, type: 'circle', source: SRC_SITES, filter: ['has', 'point_count'],
      paint: {
        'circle-color': 'rgba(16, 22, 30, 0.88)', 'circle-stroke-color': MODE_COLOR.fixed, 'circle-stroke-width': 1.5,
        'circle-radius': ['step', ['get', 'point_count'], 11, 10, 14, 30, 18],
      },
    }, before);
    map.addLayer({
      id: L_COUNT, type: 'symbol', source: SRC_SITES, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-allow-overlap': true },
      paint: { 'text-color': '#e6ecf3' },
    }, before);
    map.addLayer({
      id: L_SITE, type: 'circle', source: SRC_SITES, filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 6.5, 18, 9],
        'circle-color': ['match', ['get', 'st'], 'working', ['match', ['get', 'm'], 'adaptive', MODE_COLOR.adaptive, 'manual', MODE_COLOR.manual, MODE_COLOR.fixed], 'inactive', STATUS_COLOR.inactive, 'rgba(0,0,0,0)'],
        'circle-stroke-color': ['match', ['get', 'st'], 'no_data', STATUS_COLOR.no_data, '#0f141b'],
        'circle-stroke-width': ['match', ['get', 'st'], 'no_data', 2, 1.4],
      },
    }, before);
    map.addLayer({
      id: L_SEL, type: 'circle', source: SRC_SITES, filter: ['==', ['get', 'i'], -1],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 9, 15, 13, 18, 30], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    }, before);
    map.addLayer({
      id: L_HEADS, type: 'circle', source: SRC_HEADS, minzoom: HEADS_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], HEADS_ZOOM, 3.5, 18, 7],
        'circle-color': ['match', ['get', 'c'], 'G', LIGHT_COLOR.G, 'Y', LIGHT_COLOR.Y, 'R', LIGHT_COLOR.R, LIGHT_COLOR.off],
        'circle-stroke-color': '#0f141b', 'circle-stroke-width': 1,
        'circle-pitch-alignment': 'map',
      },
    }, before);
    map.addLayer({
      id: L_OSM, type: 'circle', source: SRC_OSM, minzoom: OSM_ZOOM,
      paint: { 'circle-radius': 2.2, 'circle-color': '#ffffff', 'circle-stroke-color': '#0f141b', 'circle-stroke-width': 0.8, 'circle-pitch-alignment': 'map' },
    }, before);
    map.on('click', L_SITE, this.onClick);
    map.on('click', L_CLUSTER, this.onClusterClick);
    for (const l of [L_SITE, L_CLUSTER]) { map.on('mouseenter', l, this.pointer); map.on('mouseleave', l, this.unpointer); }
    this.attached = true;
  }

  setVisible(v: boolean) {
    if (!this.attached) return;
    for (const l of [L_CLUSTER, L_COUNT, L_SITE, L_SEL, L_HEADS, L_OSM]) this.map.setLayoutProperty(l, 'visibility', v ? 'visible' : 'none');
  }

  setFilter(f: SignalFilter) {
    this.filter = f;
    this.refreshSites();
  }

  setSelected(i: number | null) {
    if (this.attached) this.map.setFilter(L_SEL, ['==', ['get', 'i'], i ?? -1]);
  }

  /** Режимы и состояния меняются редко — пересобрать объекты (кластеры). */
  refreshSites() {
    const src = this.map.getSource(SRC_SITES) as GeoJSONSource | undefined;
    src?.setData(sitesGeoJSON(this.sys, this.filter));
  }

  /** Сигналы въездов — часто, только в пределах экрана и на крупном масштабе. Возвращает число точек. */
  updateHeads(): number {
    if (!this.attached) return 0;
    const src = this.map.getSource(SRC_HEADS) as GeoJSONSource | undefined;
    if (!src) return 0;
    if (this.map.getZoom() < HEADS_ZOOM) { src.setData(fc([])); return 0; }
    const b = this.map.getBounds();
    const data = headsGeoJSON(this.sys, this.filter, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    src.setData(data);
    return data.features.length;
  }

  detach() {
    if (!this.attached) return;
    const map = this.map;
    try {
      map.off('click', L_SITE, this.onClick);
      map.off('click', L_CLUSTER, this.onClusterClick);
      for (const l of [L_SITE, L_CLUSTER]) { map.off('mouseenter', l, this.pointer); map.off('mouseleave', l, this.unpointer); }
      for (const l of [L_OSM, L_HEADS, L_SEL, L_SITE, L_COUNT, L_CLUSTER]) if (map.getLayer(l)) map.removeLayer(l);
      for (const s of [SRC_OSM, SRC_HEADS, SRC_SITES]) if (map.getSource(s)) map.removeSource(s);
    } catch {
      // карта уже уничтожена
    }
    this.attached = false;
  }
}
