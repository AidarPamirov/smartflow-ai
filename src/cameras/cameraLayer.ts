/**
 * Слой виртуальных камер на карте MapLibre: кружок по типу (полый — визуальный макет) и «конус» обзора,
 * повёрнутый по направлению камеры. На мелком масштабе — кластеры. Только отрисовка.
 */
import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl';
import type { CameraSystem } from './system';
import type { CameraType } from './types';

export const CAMERA_MIN_ZOOM = 12;
const SRC = 'sf-cameras';
const L_CLUSTER = 'sf-cameras-cluster';
const L_COUNT = 'sf-cameras-count';
const L_DOT = 'sf-cameras-dot';
const L_CONE = 'sf-cameras-cone';
const L_SEL = 'sf-cameras-selected';
const IMG_CONE = 'sf-camera-cone';
const BEFORE = 'street-names';

export const CAMERA_COLOR: Record<CameraType, string> = { flow: '#4dd0e1', speed: '#ff7ab6', line: '#b388ff', seatbelt: '#a0aec0' };
export type CameraFilter = Record<CameraType, boolean>;
export const ALL_CAMERAS: CameraFilter = { flow: true, speed: true, line: true, seatbelt: true };

function coneImage(): ImageData {
  const w = 24, h = 24;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(230, 236, 243, 0.85)';
  g.beginPath();
  g.moveTo(12, 2); g.lineTo(20, 16); g.lineTo(4, 16); g.closePath();
  g.fill();
  return g.getImageData(0, 0, w, h);
}

export function camerasGeoJSON(sys: CameraSystem, f: CameraFilter) {
  return {
    type: 'FeatureCollection' as const,
    features: sys.cameras.flatMap((c, i) => (f[c.type] ? [{
      type: 'Feature' as const,
      properties: { i, t: c.type, h: c.heading, mock: c.dataMode === 'mock' ? 1 : 0, on: c.settings.enabled ? 1 : 0 },
      geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] as [number, number] },
    }] : [])),
  };
}

export class CameraLayer {
  private attached = false;
  private filter: CameraFilter = ALL_CAMERAS;
  private onClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (f) this.onSelect(Number(f.properties?.i));
  };
  private onClusterClick = async (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    if (!f || !src) return;
    const zoom = await src.getClusterExpansionZoom(Number(f.properties?.cluster_id));
    this.map.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: Math.min(zoom + 0.2, 18), duration: 500 });
  };
  private pointer = () => { this.map.getCanvas().style.cursor = 'pointer'; };
  private unpointer = () => { this.map.getCanvas().style.cursor = ''; };

  constructor(private map: MlMap, private sys: CameraSystem, private onSelect: (i: number) => void) {}

  attach() {
    if (this.attached) return;
    const map = this.map;
    const before = map.getLayer(BEFORE) ? BEFORE : undefined;
    if (!map.hasImage(IMG_CONE)) map.addImage(IMG_CONE, coneImage(), { pixelRatio: 2 });
    map.addSource(SRC, { type: 'geojson', data: camerasGeoJSON(this.sys, this.filter), cluster: true, clusterMaxZoom: 14, clusterRadius: 30 });
    const color = ['match', ['get', 't'], 'flow', CAMERA_COLOR.flow, 'speed', CAMERA_COLOR.speed, 'line', CAMERA_COLOR.line, CAMERA_COLOR.seatbelt] as unknown as string;
    map.addLayer({
      id: L_CLUSTER, type: 'circle', source: SRC, minzoom: CAMERA_MIN_ZOOM, filter: ['has', 'point_count'],
      paint: { 'circle-color': 'rgba(16, 22, 30, 0.88)', 'circle-stroke-color': CAMERA_COLOR.flow, 'circle-stroke-width': 1.2, 'circle-radius': ['step', ['get', 'point_count'], 9, 10, 12] },
    }, before);
    map.addLayer({
      id: L_COUNT, type: 'symbol', source: SRC, minzoom: CAMERA_MIN_ZOOM, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-allow-overlap': true },
      paint: { 'text-color': CAMERA_COLOR.flow },
    }, before);
    map.addLayer({
      id: L_CONE, type: 'symbol', source: SRC, minzoom: 15, filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': IMG_CONE, 'icon-rotate': ['get', 'h'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
        'icon-offset': [0, -14], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 0.9,
      },
      paint: { 'icon-opacity': ['case', ['==', ['get', 'on'], 1], 0.9, 0.3] },
    }, before);
    map.addLayer({
      id: L_DOT, type: 'circle', source: SRC, minzoom: CAMERA_MIN_ZOOM, filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 6, 18, 7.5],
        'circle-color': ['case', ['==', ['get', 'mock'], 1], 'rgba(0,0,0,0)', color],
        'circle-stroke-color': ['case', ['==', ['get', 'mock'], 1], color, '#0f141b'],
        'circle-stroke-width': ['case', ['==', ['get', 'mock'], 1], 2, 1.2],
        'circle-opacity': ['case', ['==', ['get', 'on'], 1], 1, 0.35],
      },
    }, before);
    map.addLayer({
      id: L_SEL, type: 'circle', source: SRC, filter: ['==', ['get', 'i'], -1],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 12, 18, 16], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    }, before);
    map.on('click', L_DOT, this.onClick);
    map.on('click', L_CLUSTER, this.onClusterClick);
    for (const l of [L_DOT, L_CLUSTER]) { map.on('mouseenter', l, this.pointer); map.on('mouseleave', l, this.unpointer); }
    this.attached = true;
  }

  refresh() {
    (this.map.getSource(SRC) as GeoJSONSource | undefined)?.setData(camerasGeoJSON(this.sys, this.filter));
  }
  setFilter(f: CameraFilter) { this.filter = f; this.refresh(); }
  setVisible(v: boolean) {
    if (!this.attached) return;
    for (const l of [L_CLUSTER, L_COUNT, L_CONE, L_DOT, L_SEL]) this.map.setLayoutProperty(l, 'visibility', v ? 'visible' : 'none');
  }
  setSelected(i: number | null) { if (this.attached) this.map.setFilter(L_SEL, ['==', ['get', 'i'], i ?? -1]); }

  detach() {
    if (!this.attached) return;
    const map = this.map;
    try {
      map.off('click', L_DOT, this.onClick);
      map.off('click', L_CLUSTER, this.onClusterClick);
      for (const l of [L_DOT, L_CLUSTER]) { map.off('mouseenter', l, this.pointer); map.off('mouseleave', l, this.unpointer); }
      for (const l of [L_SEL, L_DOT, L_CONE, L_COUNT, L_CLUSTER]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(SRC)) map.removeSource(SRC);
      if (map.hasImage(IMG_CONE)) map.removeImage(IMG_CONE);
    } catch {
      // карта уже уничтожена
    }
    this.attached = false;
  }
}
