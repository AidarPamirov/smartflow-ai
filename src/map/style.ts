import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

/** Тип выражения стиля MapLibre (выводится из типов слоя, чтобы не тянуть отдельный пакет style-spec). */
type ExpressionSpecification = Extract<
  NonNullable<NonNullable<Extract<LayerSpecification, { type: 'line' }>['paint']>['line-width']>,
  unknown[]
>;

/**
 * Стиль базовой карты Бишкека для SmartFlow AI.
 *
 * Данные: векторные тайлы OpenFreeMap (https://openfreemap.org) в схеме OpenMapTiles,
 * построенные из OpenStreetMap. Бесплатно, без ключа, коммерческое использование разрешено;
 * атрибуция OpenMapTiles и OpenStreetMap обязательна.
 *
 * Сознательно НЕ используются слои poi, housenumber, aerodrome_label: на карте нет названий
 * и значков компаний и заведений. Здания — только геометрия.
 *
 * Высота зданий — поле render_height генератора тайлов (planetiler-openmaptiles):
 *   height из OSM → иначе building:levels × 3,66 м → иначе условные 5 м.
 * Отличить «настоящие 5 м» от «данных нет» по тайлу невозможно, поэтому это подписано в интерфейсе.
 */

export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

/** Условная высота, которую генератор тайлов ставит зданию без height и building:levels, м. */
export const DEFAULT_BUILDING_HEIGHT = 5;
/** Высота одного этажа, принятая генератором тайлов, м. */
export const LEVEL_HEIGHT = 3.66;

/** Начальный вид: центр Бишкека, площадь Ала-Тоо. */
export const BISHKEK = {
  center: [74.6036, 42.8766] as [number, number],
  zoom: 15.4,
  pitch: 58,
  bearing: -18,
  /** Камера не уходит дальше окрестностей города. */
  maxBounds: [[74.35, 42.74], [74.86, 43.0]] as [[number, number], [number, number]],
  minZoom: 10.5,
  maxZoom: 19,
  maxPitch: 70,
} as const;

export const COLORS = {
  land: '#0f141b',
  landuse: '#121923',
  park: '#122019',
  water: '#0d2131',
  waterway: '#15344b',
  rail: '#3a4350',
  roadMinor: '#2c3540',
  roadTertiary: '#38424f',
  roadSecondary: '#45515f',
  roadPrimary: '#56657a',
  roadTrunk: '#66788f',
  buildingFlat: '#1f2834',
  buildingLow: '#273140',
  buildingMid: '#3a4859',
  buildingHigh: '#5a6c84',
  buildingTop: '#8396ae',
  label: '#a7b3c4',
  labelHalo: '#0f141b',
} as const;

const SRC = 'openmaptiles';

/**
 * Ширина линии по зуму в пикселях. После 15-го зума растёт вдвое на каждый зум (основание 2),
 * то есть остаётся постоянной в метрах: на 18-м зуме в Бишкеке 1 px ≈ 0,44 м.
 */
const width = (z12: number, z15: number, z18: number): ExpressionSpecification =>
  ['interpolate', ['exponential', 2], ['zoom'], 12, z12, 15, z15, 18, z18];

const roadClasses: { id: string; classes: string[]; color: string; w: [number, number, number]; minzoom: number }[] = [
  // Ширина на 18-м зуме ≈ типичной ширине проезжей части: 6 / 10 / 14 / 18 / 22 м.
  { id: 'road-minor', classes: ['minor', 'service', 'track'], color: COLORS.roadMinor, w: [0.4, 1.7, 14], minzoom: 13 },
  { id: 'road-tertiary', classes: ['tertiary'], color: COLORS.roadTertiary, w: [0.7, 2.8, 22], minzoom: 11 },
  { id: 'road-secondary', classes: ['secondary'], color: COLORS.roadSecondary, w: [1, 4, 32], minzoom: 10 },
  { id: 'road-primary', classes: ['primary'], color: COLORS.roadPrimary, w: [1.3, 5, 40], minzoom: 9 },
  { id: 'road-trunk', classes: ['trunk', 'motorway'], color: COLORS.roadTrunk, w: [1.6, 6, 50], minzoom: 8 },
];

const heightExpr: ExpressionSpecification = ['coalesce', ['get', 'render_height'], DEFAULT_BUILDING_HEIGHT];
const minHeightExpr: ExpressionSpecification = ['coalesce', ['get', 'render_min_height'], 0];
const notHidden: ExpressionSpecification = ['!=', ['get', 'hide_3d'], true];

export type MapMode = '3d' | '2d';

export function buildLayers(): LayerSpecification[] {
  const layers: LayerSpecification[] = [
    { id: 'land', type: 'background', paint: { 'background-color': COLORS.land } },
    {
      id: 'landuse', type: 'fill', source: SRC, 'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail', 'railway'], true, false],
      paint: { 'fill-color': COLORS.landuse, 'fill-opacity': 0.7 },
    },
    {
      id: 'park', type: 'fill', source: SRC, 'source-layer': 'park',
      paint: { 'fill-color': COLORS.park, 'fill-opacity': 0.9 },
    },
    {
      id: 'landcover-green', type: 'fill', source: SRC, 'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass', 'wood', 'farmland'], true, false],
      paint: { 'fill-color': COLORS.park, 'fill-opacity': 0.55 },
    },
    {
      id: 'water', type: 'fill', source: SRC, 'source-layer': 'water',
      paint: { 'fill-color': COLORS.water },
    },
    {
      id: 'waterway', type: 'line', source: SRC, 'source-layer': 'waterway',
      paint: { 'line-color': COLORS.waterway, 'line-width': width(0.5, 1.5, 4) },
    },
  ];

  for (const r of roadClasses)
    layers.push({
      id: r.id, type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: r.minzoom,
      filter: ['all', ['match', ['get', 'class'], r.classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': r.color, 'line-width': width(...r.w) },
    });

  layers.push(
    {
      id: 'rail', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 11,
      filter: ['match', ['get', 'class'], ['rail', 'transit'], true, false],
      paint: { 'line-color': COLORS.rail, 'line-width': width(0.6, 1.4, 3), 'line-dasharray': [2, 2] },
    },
    // Плоские контуры зданий: видны в режиме «План» и как подложка на малых зумах.
    {
      id: 'building-flat', type: 'fill', source: SRC, 'source-layer': 'building', minzoom: 13,
      filter: notHidden,
      paint: { 'fill-color': COLORS.buildingFlat, 'fill-outline-color': COLORS.buildingMid },
    },
    // Объёмные здания: высота и нижняя отметка из данных тайла, цвет — по высоте.
    {
      id: 'building-3d', type: 'fill-extrusion', source: SRC, 'source-layer': 'building', minzoom: 13,
      filter: notHidden,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], heightExpr,
          0, COLORS.buildingLow, 15, COLORS.buildingMid, 45, COLORS.buildingHigh, 100, COLORS.buildingTop,
        ],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, heightExpr],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, minHeightExpr],
        'fill-extrusion-opacity': 0.94,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    // Названия улиц (без компаний и заведений).
    {
      id: 'street-names', type: 'symbol', source: SRC, 'source-layer': 'transportation_name', minzoom: 14,
      filter: ['match', ['get', 'class'], ['trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 15],
        'text-max-angle': 30,
        'symbol-spacing': 320,
      },
      paint: { 'text-color': COLORS.label, 'text-halo-color': COLORS.labelHalo, 'text-halo-width': 1.4 },
    },
    // Названия районов и микрорайонов — для ориентации.
    {
      id: 'district-names', type: 'symbol', source: SRC, 'source-layer': 'place', minzoom: 11, maxzoom: 15.5,
      filter: ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], true, false],
      layout: {
        'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 8,
      },
      paint: { 'text-color': COLORS.label, 'text-halo-color': COLORS.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.75 },
    },
  );
  return layers;
}

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'SmartFlow AI · Bishkek base',
    glyphs: GLYPHS_URL,
    sources: {
      [SRC]: { type: 'vector', url: TILEJSON_URL, attribution: ATTRIBUTION },
    },
    light: { anchor: 'viewport', color: '#ffffff', intensity: 0.32, position: [1.2, 210, 35] },
    layers: buildLayers(),
  };
}

/** Видимость слоёв зданий для режима карты. */
export function buildingVisibility(mode: MapMode): { flat: 'visible' | 'none'; extruded: 'visible' | 'none' } {
  return mode === '3d' ? { flat: 'none', extruded: 'visible' } : { flat: 'visible', extruded: 'none' };
}
