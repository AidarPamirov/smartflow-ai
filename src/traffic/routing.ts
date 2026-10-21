/**
 * Генерация синтетических маршрутов по дорожному графу.
 * Только графовые вычисления — ничего не знает о карте и отрисовке.
 */
import { mulberry32, type Rng } from '../sim/rng';
import type { Arc, Network, RoadClass } from './network';

/**
 * Условные скорости свободного движения по классам дорог, м/с. Это допущение демо-модели,
 * а не измерения: в Бишкеке общее ограничение в городе 60 км/ч.
 */
export const CLASS_SPEED: Record<RoadClass, number> = {
  motorway: 60 / 3.6,
  trunk: 55 / 3.6,
  primary: 50 / 3.6,
  secondary: 45 / 3.6,
  tertiary: 40 / 3.6,
  unclassified: 30 / 3.6,
};
/** Скорость на поворотах: угол ≥ 90° проходится не быстрее TURN_SPEED. */
export const TURN_SPEED = 18 / 3.6;
/** Минимальная длина поездки по прямой, м (короткие поездки выглядят как дёрганье на месте). */
export const MIN_TRIP = 1500;

export interface Route {
  arcs: Arc[];
  /** Полилиния маршрута в локальных метрах. */
  xs: Float64Array;
  ys: Float64Array;
  /** Накопленная длина в каждой точке. */
  cum: Float64Array;
  /** Допустимая скорость в каждой точке (класс дороги + поворот), м/с. */
  vmax: Float64Array;
  /** Индекс дуги, которой принадлежит отрезок [i, i+1]. */
  segArc: Int32Array;
  /** Начало каждой дуги в координате маршрута, м. */
  arcStart: Float64Array;
  length: number;
  from: number;
  to: number;
}

/** Бинарная куча по приоритету (для Дейкстры). */
class Heap {
  private k: number[] = [];
  private p: number[] = [];
  get size() { return this.k.length; }
  push(key: number, pri: number) {
    const k = this.k, p = this.p;
    let i = k.length;
    k.push(key); p.push(pri);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= pri) break;
      k[i] = k[j]; p[i] = p[j]; i = j;
    }
    k[i] = key; p[i] = pri;
  }
  pop(): [number, number] {
    const k = this.k, p = this.p;
    const top: [number, number] = [k[0], p[0]];
    const lk = k.pop()!, lp = p.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mp = lp;
        if (l < k.length && p[l] < mp) { m = l; mp = p[l]; }
        if (r < k.length && p[r] < mp) { m = r; mp = p[r]; }
        if (m === i) break;
        k[i] = k[m]; p[i] = p[m]; i = m;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}

/** Время проезда дуги без помех, с. */
export const arcCost = (net: Network, a: Arc) => net.edges[a.edge].length / CLASS_SPEED[net.edges[a.edge].cls];

/** Кратчайший по времени путь (Дейкстра) с учётом односторонних улиц. null — пути нет. */
export function shortestPath(net: Network, from: number, to: number): Arc[] | null {
  if (from === to) return [];
  const n = net.nodeX.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev: (Arc | null)[] = new Array(n).fill(null);
  const prevNode = new Int32Array(n).fill(-1);
  const heap = new Heap();
  dist[from] = 0;
  heap.push(from, 0);
  while (heap.size) {
    const [u, d] = heap.pop();
    if (d > dist[u]) continue;
    if (u === to) break;
    for (const a of net.out[u]) {
      const nd = d + arcCost(net, a);
      if (nd < dist[a.to]) { dist[a.to] = nd; prev[a.to] = a; prevNode[a.to] = u; heap.push(a.to, nd); }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const path: Arc[] = [];
  for (let v = to; v !== from; v = prevNode[v]) path.push(prev[v]!);
  return path.reverse();
}

/** Собирает полилинию маршрута и профиль допустимой скорости из последовательности дуг. */
export function buildRoute(net: Network, arcs: Arc[], from: number): Route {
  const xs: number[] = [], ys: number[] = [], segArc: number[] = [], vClass: number[] = [];
  const arcStart = new Float64Array(arcs.length);
  xs.push(net.nodeX[from]); ys.push(net.nodeY[from]);
  let len = 0;
  arcs.forEach((a, ai) => {
    const e = net.edges[a.edge];
    arcStart[ai] = len;
    const k = e.xs.length;
    for (let j = 1; j < k; j++) {
      const idx = a.forward ? j : k - 1 - j;
      const x = e.xs[idx], y = e.ys[idx];
      len += Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]);
      xs.push(x); ys.push(y);
      segArc.push(ai);
      vClass.push(CLASS_SPEED[e.cls]);
    }
  });
  const m = xs.length;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  // допустимая скорость в точке: минимум классов соседних отрезков, снижение на поворотах
  const vmax = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const before = i > 0 ? vClass[i - 1] : vClass[0];
    const after = i < m - 1 ? vClass[i] : vClass[m - 2];
    let v = Math.min(before, after);
    if (i > 0 && i < m - 1) {
      const ax = xs[i] - xs[i - 1], ay = ys[i] - ys[i - 1], bx = xs[i + 1] - xs[i], by = ys[i + 1] - ys[i];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 0.01 && lb > 0.01) {
        const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))); // 0 — прямо, π — разворот
        const deg = (turn * 180) / Math.PI;
        if (deg > 25) v = Math.min(v, Math.max(TURN_SPEED * 0.6, v - (v - TURN_SPEED) * Math.min(1, (deg - 25) / 65)));
      }
    }
    vmax[i] = v;
  }
  vmax[m - 1] = Math.min(vmax[m - 1], TURN_SPEED); // в конце поездки машина сбрасывает скорость
  const last = arcs.length ? arcs[arcs.length - 1].to : from;
  return { arcs, xs: new Float64Array(xs), ys: new Float64Array(ys), cum, vmax, segArc: new Int32Array(segArc), arcStart, length: cum[m - 1], from, to: last };
}

/**
 * Генератор синтетических поездок: случайная пара узлов на расстоянии не меньше MIN_TRIP,
 * кратчайший по времени путь между ними. Детерминирован по seed.
 */
export class RouteGenerator {
  private rng: Rng;
  constructor(private net: Network, seed: number) {
    this.rng = mulberry32(seed);
  }

  next(maxAttempts = 30): Route | null {
    const n = this.net.nodeX.length;
    for (let i = 0; i < maxAttempts; i++) {
      const a = Math.floor(this.rng() * n), b = Math.floor(this.rng() * n);
      const d = Math.hypot(this.net.nodeX[a] - this.net.nodeX[b], this.net.nodeY[a] - this.net.nodeY[b]);
      if (d < MIN_TRIP) continue;
      const arcs = shortestPath(this.net, a, b);
      if (arcs && arcs.length) return buildRoute(this.net, arcs, a);
    }
    return null;
  }

  /** Поездка из заданного узла в случайный узел не ближе MIN_TRIP. */
  from(node: number, maxAttempts = 12): Route | null {
    const n = this.net.nodeX.length;
    for (let i = 0; i < maxAttempts; i++) {
      const b = Math.floor(this.rng() * n);
      const d = Math.hypot(this.net.nodeX[node] - this.net.nodeX[b], this.net.nodeY[node] - this.net.nodeY[b]);
      if (d < MIN_TRIP) continue;
      const arcs = shortestPath(this.net, node, b);
      if (arcs && arcs.length) return buildRoute(this.net, arcs, node);
    }
    return null;
  }

  /** Строит пул маршрутов порциями, отдавая управление интерфейсу между порциями. */
  async pool(count: number, onProgress?: (done: number) => void, signal?: { cancelled: boolean }, chunk = 8): Promise<Route[]> {
    const out: Route[] = [];
    while (out.length < count) {
      if (signal?.cancelled) break;
      for (let i = 0; i < chunk && out.length < count; i++) {
        const r = this.next();
        if (!r) throw new Error('не удалось построить маршрут: граф несвязный');
        out.push(r);
      }
      onProgress?.(out.length);
      await new Promise((res) => setTimeout(res, 0));
    }
    return out;
  }
}
