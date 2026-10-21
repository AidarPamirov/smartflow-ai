/**
 * Цветовая карта загруженности участков (синтетика демо-трафика). Только отрисовка: данные — CongestionMeter.
 * На двусторонних улицах направления смещены вправо по ходу движения.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { LEVEL_COLOR, type CongestionMeter } from './congestion';

const SRC = 'sf-congestion';
const L = 'sf-congestion-lines';
/** Под машинами и светофорами, над дорогами. */
const BEFORE = 'building-flat';

export class CongestionLayer {
  private attached = false;
  private visible = false;

  constructor(private map: MlMap, private meter: CongestionMeter) {}

  attach() {
    if (this.attached) return;
    const map = this.map;
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: L, type: 'line', source: SRC, layout: { visibility: 'none', 'line-cap': 'round', 'line-sort-key': ['get', 'l'] },
      paint: {
        'line-color': ['match', ['get', 'l'], 0, LEVEL_COLOR[0], 1, LEVEL_COLOR[1], 2, LEVEL_COLOR[2], LEVEL_COLOR[3]],
        // загруженные участки толще: на мелком масштабе пробка не теряется среди зелёных линий
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['*', 1.5, ['+', 1, ['*', 0.6, ['get', 'l']]]],
          15, ['*', 3.5, ['+', 1, ['*', 0.4, ['get', 'l']]]], 18, ['*', 6, ['+', 1, ['*', 0.25, ['get', 'l']]]]],
        // zoom может быть только во входе верхнего interpolate: смещение 0 у односторонних (two = 0)
        'line-offset': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 'two'], 1], 15, ['*', ['get', 'two'], 2.5], 18, ['*', ['get', 'two'], 5]],
        'line-opacity': 0.8,
      },
    }, map.getLayer(BEFORE) ? BEFORE : undefined);
    this.attached = true;
  }

  get isVisible() { return this.visible; }

  setVisible(v: boolean) {
    this.visible = v;
    if (this.attached) this.map.setLayoutProperty(L, 'visibility', v ? 'visible' : 'none');
    if (v) this.update();
  }

  update() {
    if (!this.attached || !this.visible) return;
    (this.map.getSource(SRC) as GeoJSONSource | undefined)?.setData(this.meter.geojson());
  }

  detach() {
    if (!this.attached) return;
    try {
      if (this.map.getLayer(L)) this.map.removeLayer(L);
      if (this.map.getSource(SRC)) this.map.removeSource(SRC);
    } catch {
      // карта уже уничтожена
    }
    this.attached = false;
  }
}
