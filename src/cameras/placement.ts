/**
 * Расстановка виртуальных камер по правилам. Это НЕ расположение реальных камер Бишкека (таких открытых данных
 * в проекте нет): камеры ставятся туда, где они полезны модели, и это видно по их режиму данных.
 *
 *  - камера потока — на главном въезде каждого светофора с магистралью (trunk/primary), в 30 м до стоп-линии;
 *  - камера скорости — посередине длинных (≥ 300 м) участков магистралей, участок измерения 100 м, не ближе 700 м
 *    друг к другу;
 *  - камера сплошной линии — на двусторонних въездах к светофорам: линия — ось дороги на последних 30 м до стоп-линии
 *    (выезд на встречную перед перекрёстком);
 *  - камера ремня — несколько визуальных макетов на крупных перекрёстках (модели распознавания нет).
 */
import { STOP_BACK } from '../traffic/fleet';
import { CLASS_SPEED } from '../traffic/routing';
import { toLonLat, type Network, type RoadClass } from '../traffic/network';
import type { SignalSystem } from '../signals/system';
import type { Camera, CameraSettings, CameraType } from './types';

const MAJOR: RoadClass[] = ['motorway', 'trunk', 'primary'];
const RANK: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'];
export const FLOW_BEFORE_STOP = 30;
export const SPEED_SECTION = 100;
export const SPEED_MIN_EDGE = 300;
export const SPEED_SPACING = 700;
export const LINE_LENGTH = 30;
export const MAX_LINE = 12;
export const MAX_SEATBELT = 5;

export const DEFAULT_SETTINGS: Record<CameraType, CameraSettings> = {
  flow: { enabled: true, sensitivity: 15, confidenceThreshold: 0.8 },
  speed: { enabled: true, sensitivity: 2, confidenceThreshold: 0.8 },
  line: { enabled: true, sensitivity: 0.3, confidenceThreshold: 0.8 },
  seatbelt: { enabled: true, sensitivity: 0, confidenceThreshold: 0.8 },
};

/** Точка и азимут на направленном ребре в dist м от его начала по ходу движения. */
export function pointOnArc(net: Network, edge: number, forward: boolean, dist: number): { x: number; y: number; heading: number } {
  const e = net.edges[edge];
  const k = e.xs.length;
  let acc = 0;
  for (let j = 1; j < k; j++) {
    const a = forward ? j - 1 : k - j, b = forward ? j : k - 1 - j;
    const dx = e.xs[b] - e.xs[a], dy = e.ys[b] - e.ys[a];
    const d = Math.hypot(dx, dy);
    if (acc + d >= dist || j === k - 1) {
      const t = d > 0 ? Math.min(1, Math.max(0, (dist - acc) / d)) : 0;
      return { x: e.xs[a] + dx * t, y: e.ys[a] + dy * t, heading: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
    }
    acc += d;
  }
  return { x: e.xs[0], y: e.ys[0], heading: 0 };
}

/** Ломаная направленного ребра между отметками [d0, d1] (м от начала по ходу). */
export function arcSlice(net: Network, edge: number, forward: boolean, d0: number, d1: number, step = 5): [number, number][] {
  const out: [number, number][] = [];
  for (let d = d0; d < d1; d += step) { const p = pointOnArc(net, edge, forward, d); out.push([p.x, p.y]); }
  const p = pointOnArc(net, edge, forward, d1);
  out.push([p.x, p.y]);
  return out;
}

export function placeCameras(net: Network, sys: SignalSystem): Camera[] {
  const cams: Camera[] = [];
  const add = (type: CameraType, n: number, edge: number, forward: boolean, marks: number[], at: number, signal: number) => {
    const p = pointOnArc(net, edge, forward, at);
    const [lon, lat] = toLonLat(net.proj, p.x, p.y);
    const e = net.edges[edge];
    cams.push({
      id: `cam-${type}-${String(n).padStart(3, '0')}`, type,
      lon: Math.round(lon * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6, heading: Math.round(p.heading),
      edge, forward, marks, street: e.name, signal,
      limitKmh: Math.round(CLASS_SPEED[e.cls] * 3.6),
      dataMode: type === 'seatbelt' ? 'mock' : 'synthetic',
      settings: { ...DEFAULT_SETTINGS[type] },
    });
  };
  const stopAt = (len: number) => len - Math.min(STOP_BACK, len * 0.5);

  // поток: главный въезд светофоров с магистралью
  const majorSites = sys.items.filter((it) => it.rt && it.site.legs.some((l) => MAJOR.includes(l.cls)));
  let nFlow = 0;
  const flowArcs: { edge: number; forward: boolean; item: number }[] = [];
  for (const it of majorSites) {
    const legs = it.site.legs.filter((l, li) => l.inbound.length && it.legGroup[li] >= 0)
      .sort((a, b) => RANK.indexOf(a.cls) - RANK.indexOf(b.cls) || b.lanesIn - a.lanesIn || a.bearing - b.bearing);
    for (const leg of legs) {
      const d = leg.inbound.find((x) => net.edges[x.edge].length >= 60);
      if (!d) continue;
      const len = net.edges[d.edge].length;
      const m = Math.max(5, stopAt(len) - FLOW_BEFORE_STOP);
      add('flow', ++nFlow, d.edge, d.forward, [m], m, it.index);
      flowArcs.push({ edge: d.edge, forward: d.forward, item: it.index });
      break;
    }
  }

  // скорость: середина длинных участков магистралей, с разносом
  const speedCand = net.edges.filter((e) => MAJOR.includes(e.cls) && e.length >= SPEED_MIN_EDGE).sort((a, b) => b.length - a.length);
  const placed: { x: number; y: number }[] = [];
  let nSpeed = 0;
  for (const e of speedCand) {
    const mid = pointOnArc(net, e.id, true, e.length / 2);
    if (placed.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < SPEED_SPACING)) continue;
    placed.push(mid);
    const m0 = e.length / 2 - SPEED_SECTION / 2, m1 = e.length / 2 + SPEED_SECTION / 2;
    add('speed', ++nSpeed, e.id, true, [m0, m1], e.length / 2, -1);
  }

  // сплошная линия: двусторонние въезды к светофорам (ось дороги перед стоп-линией)
  let nLine = 0;
  for (const it of sys.items) {
    if (nLine >= MAX_LINE) break;
    if (!it.rt) continue;
    const leg = it.site.legs.find((l, li) => it.legGroup[li] >= 0 && (l.cls === 'primary' || l.cls === 'secondary') && l.inbound.some((x) => !net.edges[x.edge].oneway && net.edges[x.edge].length >= 80));
    if (!leg) continue;
    const d = leg.inbound.find((x) => !net.edges[x.edge].oneway && net.edges[x.edge].length >= 80)!;
    const s1 = stopAt(net.edges[d.edge].length), s0 = s1 - LINE_LENGTH;
    add('line', ++nLine, d.edge, d.forward, [s0, s1], (s0 + s1) / 2, it.index);
  }

  // ремень: макеты на самых крупных перекрёстках (по числу полос на главном въезде камеры потока)
  const bySize = flowArcs
    .map((f) => ({ f, lanes: sys.items[f.item].site.legs.reduce((a, l) => a + l.lanesIn, 0) }))
    .sort((a, b) => b.lanes - a.lanes || a.f.item - b.f.item)
    .slice(0, MAX_SEATBELT);
  let nBelt = 0;
  for (const { f } of bySize) {
    const len = net.edges[f.edge].length;
    const m = Math.max(5, stopAt(len) - 12);
    add('seatbelt', ++nBelt, f.edge, f.forward, [m], m, f.item);
  }
  return cams;
}
