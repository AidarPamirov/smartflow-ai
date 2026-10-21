/**
 * Светофорные объекты города из фактов OSM и дорожного графа.
 *
 * Вход — только факты: узлы OSM highway=traffic_signals и пешеходные переходы
 * (scripts/build-signals.mjs → public/data/bishkek-signals-osm.json) и дорожный граф (src/traffic/network.ts).
 * Выход — «светофорные объекты»: перекрёсток графа, у которого в OSM отмечен светофор, с подходами и переходами.
 *
 * Правила (их проверяют tests/signals.test.ts):
 *  - светофорный объект появляется ТОЛЬКО там, где в OSM есть узел highway=traffic_signals; узлы графа без
 *    светофора в OSM не регулируются, даже если это большой перекрёсток;
 *  - светофор относится к ближайшей развилке графа (≥ 3 участков) не дальше ASSIGN_M; светофор у перехода —
 *    не дальше ASSIGN_CROSSING_M, иначе это пешеходный светофор вне перекрёстка;
 *  - узлы графа, связанные с развилкой короткими участками (≤ LINK_M), входят в тот же объект: так перекрёсток
 *    с разделёнными проезжими частями становится одним объектом, а не двумя-четырьмя;
 *  - подход — внешний участок объекта; участки с близким азимутом (≤ LEG_MERGE_DEG) и той же улицей
 *    объединяются в один подход (въездная и выездная проезжие части).
 * Это вывод из данных, а не официальная схема перекрёстка: число полос и направление движения берутся из графа.
 */
import type { Network, RoadClass } from '../traffic/network';
import { toXY } from '../traffic/network';

export const OSM_SIGNALS_FORMAT = 'smartflow-osm-signals/1';

export const ASSIGN_M = 40;
export const ASSIGN_CROSSING_M = 30;
export const LINK_M = 45;
export const MAX_DIAMETER_M = 110;
export const LEG_MERGE_DEG = 25;
export const CROSSING_RADIUS_M = 50;
const BEARING_PROBE_M = 40;

export interface OsmNode { id: number; lon: number; lat: number; tags: Record<string, string> }

export interface RawOsmSignals {
  format: string;
  meta: { osm_base: string | null; generated: string; attribution: string; license: string; bbox: [number, number, number, number]; signals: number; crossings: number };
  signals: OsmNode[];
  crossings: OsmNode[];
}

export class SignalDataError extends Error {}

export function parseOsmSignals(raw: unknown): RawOsmSignals {
  const r = raw as Partial<RawOsmSignals>;
  if (!r || typeof r !== 'object') throw new SignalDataError('файл светофоров пустой или не JSON');
  if (r.format !== OSM_SIGNALS_FORMAT) throw new SignalDataError(`неизвестный формат файла светофоров: ${String(r.format)}`);
  if (!r.meta || !Array.isArray(r.signals) || !Array.isArray(r.crossings)) throw new SignalDataError('в файле светофоров нет данных');
  for (const n of [...r.signals, ...r.crossings])
    if (!Number.isFinite(n?.id) || !Number.isFinite(n?.lon) || !Number.isFinite(n?.lat) || typeof n.tags !== 'object')
      throw new SignalDataError(`повреждён узел ${String(n?.id)}`);
  return r as RawOsmSignals;
}

/** Направленный участок графа: ребро и направление проезда. */
export interface DirEdge { edge: number; forward: boolean }

export interface Leg {
  /** Азимут подхода от центра объекта наружу, градусы от севера по часовой стрелке. */
  bearing: number;
  name: string;
  cls: RoadClass;
  /** Полосы на въезд / выезд по тегу lanes; 0 — неизвестно. Для двусторонних улиц — половина lanes (приближение). */
  lanesIn: number;
  lanesOut: number;
  /** Участки, по которым въезжают в объект (конец участка — узел объекта). */
  inbound: DirEdge[];
  outbound: DirEdge[];
}

export type SiteStatus = 'ok' | 'no_data';

export interface SignalSite {
  /** Устойчивый ID: «tls-» + наименьший id узла OSM со светофором в объекте. */
  id: string;
  lon: number;
  lat: number;
  x: number;
  y: number;
  /** Узлы графа, входящие в объект. */
  nodes: number[];
  /** id узлов OSM highway=traffic_signals, отнесённых к объекту. */
  osmSignals: number[];
  legs: Leg[];
  crossings: { total: number; signalized: number };
  /** Наибольшее расстояние между узлами объекта, м (для проверки кластеризации). */
  diameter: number;
  status: SiteStatus;
  note: string | null;
}

export interface StandaloneSignal {
  id: string;
  osm: number;
  lon: number;
  lat: number;
  /** pedestrian — светофор у перехода вне перекрёстка; off_graph — рядом нет развилки графа (улица не в графе). */
  reason: 'pedestrian' | 'off_graph';
}

export interface Inventory {
  sites: SignalSite[];
  standalone: StandaloneSignal[];
  stats: { osmSignals: number; assigned: number; standalone: number; sites: number; noData: number };
  meta: RawOsmSignals['meta'];
}

const CLASS_RANK: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'];

/** Азимут вектора (dx — восток, dy — север), градусы [0, 360). */
export const bearingOf = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
export const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Сетка для поиска ближайших узлов. */
class Grid {
  private cells = new Map<string, number[]>();
  constructor(private size: number) {}
  private key(x: number, y: number) { return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`; }
  add(i: number, x: number, y: number) {
    const k = this.key(x, y);
    const c = this.cells.get(k);
    if (c) c.push(i); else this.cells.set(k, [i]);
  }
  near(x: number, y: number): number[] {
    const cx = Math.floor(x / this.size), cy = Math.floor(y / this.size);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(this.cells.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  }
}

class UnionFind {
  p: Int32Array;
  constructor(n: number) { this.p = new Int32Array(n).map((_, i) => i); }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}

/** Точка на ребре в BEARING_PROBE_M от узла `fromNode` (по геометрии ребра). */
function probe(net: Network, edge: number, fromNode: number): [number, number] {
  const e = net.edges[edge];
  const k = e.xs.length;
  const fwd = e.from === fromNode;
  let acc = 0;
  let px = fwd ? e.xs[0] : e.xs[k - 1], py = fwd ? e.ys[0] : e.ys[k - 1];
  for (let j = 1; j < k; j++) {
    const i = fwd ? j : k - 1 - j;
    const d = Math.hypot(e.xs[i] - px, e.ys[i] - py);
    if (acc + d >= BEARING_PROBE_M) {
      const t = (BEARING_PROBE_M - acc) / d;
      return [px + (e.xs[i] - px) * t, py + (e.ys[i] - py) * t];
    }
    acc += d;
    px = e.xs[i]; py = e.ys[i];
  }
  return [px, py];
}

export function buildInventory(net: Network, osm: RawOsmSignals): Inventory {
  const n = net.nodeX.length;
  const degree = new Int32Array(n);
  const incident: number[][] = Array.from({ length: n }, () => []);
  net.edges.forEach((e, i) => { degree[e.from]++; degree[e.to]++; incident[e.from].push(i); incident[e.to].push(i); });
  const isJunction = (k: number) => degree[k] >= 3;

  const grid = new Grid(ASSIGN_M);
  for (let k = 0; k < n; k++) if (isJunction(k)) grid.add(k, net.nodeX[k], net.nodeY[k]);

  // 1. светофор → ближайшая развилка графа
  const signalsAt = new Map<number, number[]>();
  const standalone: StandaloneSignal[] = [];
  const crossingXY = osm.crossings.map((c) => toXY(net.proj, c.lon, c.lat));
  for (const s of osm.signals) {
    const [x, y] = toXY(net.proj, s.lon, s.lat);
    const isCrossing = s.tags.crossing !== undefined;
    const limit = isCrossing ? ASSIGN_CROSSING_M : ASSIGN_M;
    let best = -1, bd = Infinity;
    for (const k of grid.near(x, y)) {
      const d = Math.hypot(net.nodeX[k] - x, net.nodeY[k] - y);
      if (d < bd) { bd = d; best = k; }
    }
    if (best >= 0 && bd <= limit) {
      const arr = signalsAt.get(best);
      if (arr) arr.push(s.id); else signalsAt.set(best, [s.id]);
    } else {
      const nearCrossing = isCrossing || crossingXY.some(([cx, cy]) => Math.hypot(cx - x, cy - y) <= 15);
      standalone.push({ id: `sig-${s.id}`, osm: s.id, lon: s.lon, lat: s.lat, reason: nearCrossing ? 'pedestrian' : 'off_graph' });
    }
  }

  // 2. кластеры: развилка со светофором + развилки, связанные с ней коротким участком
  const uf = new UnionFind(n);
  const member = new Uint8Array(n);
  for (const k of signalsAt.keys()) {
    member[k] = 1;
    for (const ei of incident[k]) {
      const e = net.edges[ei];
      const o = e.from === k ? e.to : e.from;
      if (e.length <= LINK_M && isJunction(o)) { member[o] = 1; uf.union(k, o); }
    }
  }
  const groups = new Map<number, number[]>();
  for (let k = 0; k < n; k++) if (member[k]) {
    const r = uf.find(k);
    const g = groups.get(r);
    if (g) g.push(k); else groups.set(r, [k]);
  }
  // кластер с узлами без своих светофоров, но без узлов со светофорами — не объект (такого не бывает по построению)

  const crossingsAll = osm.crossings.map((c, i) => ({ c, x: crossingXY[i][0], y: crossingXY[i][1] }));
  const sites: SignalSite[] = [];
  for (const nodes of groups.values()) {
    nodes.sort((a, b) => a - b);
    const inSite = new Set(nodes);
    const osmSignals = nodes.flatMap((k) => signalsAt.get(k) ?? []).sort((a, b) => a - b);
    if (!osmSignals.length) continue;
    const x = nodes.reduce((a, k) => a + net.nodeX[k], 0) / nodes.length;
    const y = nodes.reduce((a, k) => a + net.nodeY[k], 0) / nodes.length;
    let diameter = 0;
    for (const a of nodes) for (const b of nodes) diameter = Math.max(diameter, Math.hypot(net.nodeX[a] - net.nodeX[b], net.nodeY[a] - net.nodeY[b]));

    // 3. подходы: внешние участки, сгруппированные по азимуту и названию
    interface Ext { edge: number; inner: number; bearing: number; inbound: DirEdge | null; outbound: DirEdge | null }
    const ext: Ext[] = [];
    for (const k of nodes)
      for (const ei of incident[k]) {
        const e = net.edges[ei];
        const fromIn = inSite.has(e.from), toIn = inSite.has(e.to);
        if (fromIn && toIn) continue; // внутренний участок объекта
        const [px, py] = probe(net, ei, k);
        const bearing = bearingOf(px - x, py - y);
        // въезд: движение снаружи к узлу объекта
        const inbound: DirEdge | null = toIn ? { edge: ei, forward: true } : !e.oneway ? { edge: ei, forward: false } : null;
        const outbound: DirEdge | null = fromIn ? { edge: ei, forward: true } : !e.oneway ? { edge: ei, forward: false } : null;
        ext.push({ edge: ei, inner: k, bearing, inbound, outbound });
      }
    ext.sort((a, b) => a.bearing - b.bearing);
    const legsRaw: Ext[][] = [];
    for (const xe of ext) {
      const name = net.edges[xe.edge].name;
      const leg = legsRaw.find((l) => {
        const ref = l[0];
        const rn = net.edges[ref.edge].name;
        return angleDiff(ref.bearing, xe.bearing) <= LEG_MERGE_DEG && (rn === name || !rn || !name);
      });
      if (leg) leg.push(xe); else legsRaw.push([xe]);
    }
    const legs: Leg[] = legsRaw.map((l) => {
      const es = l.map((xe) => net.edges[xe.edge]);
      const names = es.map((e) => e.name).filter(Boolean);
      const cls = es.map((e) => e.cls).sort((a, b) => CLASS_RANK.indexOf(a) - CLASS_RANK.indexOf(b))[0];
      const lanesFor = (dir: 'in' | 'out') => {
        let sum = 0;
        for (const xe of l) {
          const e = net.edges[xe.edge];
          const has = dir === 'in' ? xe.inbound : xe.outbound;
          if (!has) continue;
          if (!e.lanes) return 0; // хотя бы у одного участка число полос неизвестно
          sum += e.oneway ? e.lanes : Math.max(1, Math.round(e.lanes / 2));
        }
        return sum;
      };
      // азимут подхода — средний по участкам (через векторы)
      let sx = 0, sy = 0;
      for (const xe of l) { sx += Math.sin((xe.bearing * Math.PI) / 180); sy += Math.cos((xe.bearing * Math.PI) / 180); }
      return {
        bearing: Math.round(bearingOf(sx, sy) * 10) / 10,
        name: names.sort((a, b) => names.filter((v) => v === b).length - names.filter((v) => v === a).length)[0] ?? '',
        cls,
        lanesIn: lanesFor('in'),
        lanesOut: lanesFor('out'),
        inbound: l.flatMap((xe) => (xe.inbound ? [xe.inbound] : [])),
        outbound: l.flatMap((xe) => (xe.outbound ? [xe.outbound] : [])),
      };
    });
    legs.sort((a, b) => a.bearing - b.bearing);

    const cr = crossingsAll.filter((c) => Math.hypot(c.x - x, c.y - y) <= CROSSING_RADIUS_M);
    const inLegs = legs.filter((l) => l.inbound.length > 0).length;
    let status: SiteStatus = 'ok';
    let note: string | null = null;
    if (inLegs < 2) { status = 'no_data'; note = 'в дорожном графе меньше двух въездов: часть улиц перекрёстка не входит в граф'; }
    else if (diameter > MAX_DIAMETER_M) { status = 'no_data'; note = `объект слишком велик (${Math.round(diameter)} м): возможно, склеены соседние перекрёстки`; }
    const [lon, lat] = [net.proj.lon0 + x / net.proj.kx, net.proj.lat0 + y / net.proj.ky];
    sites.push({
      id: `tls-${osmSignals[0]}`,
      lon: Math.round(lon * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6, x, y,
      nodes, osmSignals, legs,
      crossings: { total: cr.length, signalized: cr.filter((c) => c.c.tags.crossing === 'traffic_signals').length },
      diameter: Math.round(diameter * 10) / 10,
      status, note,
    });
  }
  sites.sort((a, b) => (a.id < b.id ? -1 : 1));
  const assigned = [...signalsAt.values()].reduce((a, v) => a + v.length, 0);
  return {
    sites,
    standalone,
    stats: { osmSignals: osm.signals.length, assigned, standalone: standalone.length, sites: sites.length, noData: sites.filter((s) => s.status === 'no_data').length },
    meta: osm.meta,
  };
}
