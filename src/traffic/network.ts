/**
 * Дорожный граф для демо-трафика: загрузка, проверка и перевод в локальные метры.
 *
 * Файл строится скриптом scripts/build-road-network.mjs из OpenStreetMap (© OpenStreetMap contributors, ODbL).
 * Перекрёсток графа — узел OSM, общий для нескольких линий; геометрия ребра — точки линии OSM между перекрёстками.
 */

export const NETWORK_FORMAT = 'smartflow-road-network/1';

export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified';

export interface NetworkMeta {
  title: string;
  source: string;
  osm_base: string | null;
  generated: string;
  license: string;
  attribution: string;
  bbox: [number, number, number, number]; // west, south, east, north
  nodes: number;
  edges: number;
  km: number;
}

/** Формат файла: компактные массивы. */
export interface RawNetwork {
  format: string;
  meta: NetworkMeta;
  classes: string[];
  names: string[];
  nodes: number[]; // lon, lat, lon, lat…
  edges: [from: number, to: number, cls: number, oneway: number, name: number, lanes: number, mid: number[]][];
}

export interface Edge {
  id: number;
  from: number;
  to: number;
  cls: RoadClass;
  oneway: boolean;
  name: string;
  lanes: number;
  /** Полилиния от узла from к узлу to в локальных метрах (включая концы). */
  xs: Float64Array;
  ys: Float64Array;
  length: number;
}

/** Дуга графа: ребро, проходимое в одном направлении. */
export interface Arc { edge: number; forward: boolean; to: number }

export interface Network {
  meta: NetworkMeta;
  nodeX: Float64Array;
  nodeY: Float64Array;
  edges: Edge[];
  /** Исходящие дуги каждого узла с учётом односторонних улиц. */
  out: Arc[][];
  proj: Projection;
}

/** Локальная равнопромежуточная проекция вокруг центра рамки: погрешность в пределах города — доли процента. */
export interface Projection { lon0: number; lat0: number; kx: number; ky: number }

const R = 6371008.8;
export function makeProjection(lon0: number, lat0: number): Projection {
  const k = (Math.PI / 180) * R;
  return { lon0, lat0, kx: k * Math.cos((lat0 * Math.PI) / 180), ky: k };
}
export const toXY = (p: Projection, lon: number, lat: number): [number, number] => [(lon - p.lon0) * p.kx, (lat - p.lat0) * p.ky];
export const toLonLat = (p: Projection, x: number, y: number): [number, number] => [p.lon0 + x / p.kx, p.lat0 + y / p.ky];

export class NetworkError extends Error {}

const CLASSES: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'];

/** Проверяет файл и строит граф. Бросает NetworkError с понятным описанием. */
export function parseNetwork(raw: unknown): Network {
  const r = raw as Partial<RawNetwork>;
  if (!r || typeof r !== 'object') throw new NetworkError('файл сети пустой или не JSON');
  if (r.format !== NETWORK_FORMAT) throw new NetworkError(`неизвестный формат файла сети: ${String(r.format)}`);
  if (!r.meta || !Array.isArray(r.meta.bbox) || r.meta.bbox.length !== 4) throw new NetworkError('в файле сети нет рамки (bbox)');
  if (!Array.isArray(r.nodes) || r.nodes.length < 4 || r.nodes.length % 2) throw new NetworkError('в файле сети нет узлов');
  if (!Array.isArray(r.edges) || r.edges.length === 0) throw new NetworkError('в файле сети нет дорог');
  if (!Array.isArray(r.classes) || !Array.isArray(r.names)) throw new NetworkError('в файле сети нет справочников');
  const classes = r.classes.map((c) => {
    if (!CLASSES.includes(c as RoadClass)) throw new NetworkError(`неизвестный класс дороги: ${c}`);
    return c as RoadClass;
  });

  const [w, s, e, n] = r.meta.bbox;
  const margin = 0.05; // линии могут выходить за рамку запроса
  const inside = (lon: number, lat: number) => lon > w - margin && lon < e + margin && lat > s - margin && lat < n + margin;
  const proj = makeProjection((w + e) / 2, (s + n) / 2);

  const nn = r.nodes.length / 2;
  const nodeX = new Float64Array(nn);
  const nodeY = new Float64Array(nn);
  for (let i = 0; i < nn; i++) {
    const lon = r.nodes[2 * i], lat = r.nodes[2 * i + 1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inside(lon, lat)) throw new NetworkError(`узел ${i} вне рамки Бишкека`);
    [nodeX[i], nodeY[i]] = toXY(proj, lon, lat);
  }

  const out: Arc[][] = Array.from({ length: nn }, () => []);
  const edges: Edge[] = r.edges.map((row, id) => {
    const [from, to, cls, oneway, name, lanes, mid] = row;
    if (!(from >= 0 && from < nn && to >= 0 && to < nn)) throw new NetworkError(`ребро ${id} ссылается на несуществующий узел`);
    if (!(cls >= 0 && cls < classes.length)) throw new NetworkError(`ребро ${id}: неверный класс`);
    if (!Array.isArray(mid) || mid.length % 2) throw new NetworkError(`ребро ${id}: повреждена геометрия`);
    const k = mid.length / 2 + 2;
    const xs = new Float64Array(k), ys = new Float64Array(k);
    xs[0] = nodeX[from]; ys[0] = nodeY[from];
    for (let i = 0; i < mid.length / 2; i++) {
      if (!inside(mid[2 * i], mid[2 * i + 1])) throw new NetworkError(`ребро ${id}: точка вне рамки`);
      [xs[i + 1], ys[i + 1]] = toXY(proj, mid[2 * i], mid[2 * i + 1]);
    }
    xs[k - 1] = nodeX[to]; ys[k - 1] = nodeY[to];
    let length = 0;
    for (let i = 1; i < k; i++) length += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const edge: Edge = { id, from, to, cls: classes[cls], oneway: oneway === 1, name: r.names![name] ?? '', lanes: lanes || 0, xs, ys, length };
    out[from].push({ edge: id, forward: true, to });
    if (!edge.oneway) out[to].push({ edge: id, forward: false, to: from });
    return edge;
  });

  return { meta: r.meta as NetworkMeta, nodeX, nodeY, edges, out, proj };
}

/** Загружает и проверяет сеть. Ошибки сети и формата — NetworkError с текстом для интерфейса. */
export async function loadNetwork(url: string, signal?: AbortSignal): Promise<Network> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetworkError('нет связи с сервером, файл дорожной сети не загрузился');
  }
  if (!res.ok) throw new NetworkError(`файл дорожной сети не найден (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new NetworkError('файл дорожной сети повреждён (не JSON)');
  }
  return parseNetwork(json);
}

export interface LineFeatureCollection {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: { cls: RoadClass; oneway: boolean }; geometry: { type: 'LineString'; coordinates: [number, number][] } }[];
}

/** Линии сети в GeoJSON (для отладочного слоя «дорожный граф»). */
export function networkToGeoJSON(net: Network): LineFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: net.edges.map((e) => {
      const coords: [number, number][] = [];
      for (let i = 0; i < e.xs.length; i++) coords.push(toLonLat(net.proj, e.xs[i], e.ys[i]));
      return { type: 'Feature', properties: { cls: e.cls, oneway: e.oneway }, geometry: { type: 'LineString', coordinates: coords } };
    }),
  };
}
