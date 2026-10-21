/**
 * Движение синтетических машин по готовым маршрутам.
 * Не знает ни о карте, ни о том, как строятся маршруты: получает их из пула.
 *
 * Модель намеренно простая: разгон и торможение, снижение скорости перед поворотами,
 * дистанция до машины впереди на той же дуге. Светофоров и приоритета на перекрёстках нет.
 */
import { mulberry32, type Rng } from '../sim/rng';
import type { Route } from './routing';

export const ACCEL = 1.5; // м/с²
export const DECEL = 3.0; // м/с²
export const CAR_LEN = 4.6; // м
export const MIN_GAP = 2.0; // м, зазор в пробке
export const HEADWAY = 1.2; // с
/** Смещение вправо от оси двусторонней улицы, м: машины встречных направлений не накладываются. */
export const RIGHT_OFFSET = 2.2;
export const MAX_SUBSTEP = 0.2; // с

export interface Vehicle {
  id: number;
  route: Route;
  /** Положение переднего бампера вдоль маршрута, м. */
  s: number;
  v: number;
  /** Индивидуальный множитель желаемой скорости (0,85–1,05). */
  k: number;
  seg: number;
  arc: number;
}

export interface VehiclePose { id: number; x: number; y: number; heading: number; v: number }

export interface FleetStats { vehicles: number; trips: number; meanSpeed: number; simTime: number }

export class Fleet {
  vehicles: Vehicle[] = [];
  simTime = 0;
  trips = 0;
  private rng: Rng;
  private nextId = 1;

  /**
   * @param routes   пул маршрутов для начальной расстановки
   * @param twoWay   двусторонняя ли дуга маршрута (для смещения к правому краю)
   * @param continueFrom новая поездка из узла, где закончилась предыдущая; null — взять маршрут из пула
   */
  constructor(
    private routes: Route[],
    private seed: number,
    count: number,
    private twoWay: (r: Route, arc: number) => boolean,
    private continueFrom?: (node: number) => Route | null,
  ) {
    if (!routes.length) throw new Error('пул маршрутов пуст');
    this.rng = mulberry32(seed);
    this.setCount(count);
  }

  /** Начальное состояние с тем же seed. */
  reset(count = this.vehicles.length) {
    this.rng = mulberry32(this.seed);
    this.vehicles = [];
    this.simTime = 0;
    this.trips = 0;
    this.nextId = 1;
    this.setCount(count);
  }

  setCount(count: number) {
    while (this.vehicles.length > count) this.vehicles.pop();
    while (this.vehicles.length < count) {
      const route = this.pick();
      // при старте машины распределены вдоль маршрутов, чтобы город не был пустым
      const s = this.rng() * route.length * 0.9;
      const v: Vehicle = { id: this.nextId++, route, s, v: 0, k: 0.85 + this.rng() * 0.2, seg: 0, arc: 0 };
      this.locate(v);
      v.v = this.limitAt(v) * 0.6;
      this.vehicles.push(v);
    }
  }

  private pick(): Route {
    return this.routes[Math.floor(this.rng() * this.routes.length)];
  }

  /** Обновляет индексы отрезка и дуги по текущему s (s только растёт). */
  private locate(v: Vehicle) {
    const r = v.route;
    while (v.seg < r.cum.length - 2 && r.cum[v.seg + 1] <= v.s) v.seg++;
    v.arc = r.segArc[v.seg];
  }

  /** Допустимая скорость с учётом ближайших точек впереди (успеть затормозить до них). */
  private limitAt(v: Vehicle): number {
    const r = v.route;
    let lim = r.vmax[v.seg] * v.k;
    const horizon = (v.v * v.v) / (2 * DECEL) + 15;
    for (let i = v.seg + 1; i < r.cum.length; i++) {
      const d = r.cum[i] - v.s;
      if (d > horizon) break;
      lim = Math.min(lim, Math.sqrt(r.vmax[i] * r.vmax[i] + 2 * DECEL * Math.max(0, d - 1)));
    }
    return lim;
  }

  /** Ключ направленной дуги: машины на одной улице в одном направлении держат дистанцию. */
  private arcKey(v: Vehicle): number {
    const a = v.route.arcs[v.arc];
    return a.edge * 2 + (a.forward ? 0 : 1);
  }

  step(dt: number) {
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(MAX_SUBSTEP, left);
      this.substep(h);
      left -= h;
    }
  }

  private substep(dt: number) {
    // лидеры: группируем по направленной дуге, положение — от начала дуги
    const groups = new Map<number, Vehicle[]>();
    for (const v of this.vehicles) {
      const key = this.arcKey(v);
      const g = groups.get(key);
      if (g) g.push(v); else groups.set(key, [v]);
    }
    const leaderGap = new Map<Vehicle, { gap: number; v: number }>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const local = (x: Vehicle) => x.s - x.route.arcStart[x.arc];
      g.sort((a, b) => local(b) - local(a));
      for (let i = 1; i < g.length; i++) leaderGap.set(g[i], { gap: local(g[i - 1]) - local(g[i]) - CAR_LEN, v: g[i - 1].v });
    }
    for (const v of this.vehicles) {
      let target = this.limitAt(v);
      const L = leaderGap.get(v);
      if (L) {
        const want = MIN_GAP + v.v * HEADWAY;
        if (L.gap < want) target = Math.min(target, L.v * Math.max(0, L.gap - MIN_GAP) / Math.max(want - MIN_GAP, 0.1));
      }
      const dv = target - v.v;
      v.v = Math.max(0, v.v + Math.max(-DECEL * dt, Math.min(ACCEL * dt, dv)));
      let ds = v.v * dt;
      if (L) ds = Math.min(ds, Math.max(0, L.gap - MIN_GAP * 0.5)); // не въезжать в машину впереди
      v.s += ds;
      if (v.s >= v.route.length) {
        // поездка завершена: следующая начинается там же, где закончилась эта (если удалось построить)
        this.trips++;
        const over = v.s - v.route.length;
        v.route = this.continueFrom?.(v.route.to) ?? this.pick();
        v.s = Math.min(over, v.route.length * 0.5);
        v.seg = 0;
        v.v = Math.min(v.v, v.route.vmax[0]);
      }
      this.locate(v);
    }
    this.simTime += dt;
  }

  /** Положение машины: точка на полилинии маршрута, смещённая вправо на двусторонних улицах. */
  pose(v: Vehicle): VehiclePose {
    const r = v.route;
    const i = v.seg;
    const x0 = r.xs[i], y0 = r.ys[i], x1 = r.xs[i + 1], y1 = r.ys[i + 1];
    const segLen = r.cum[i + 1] - r.cum[i];
    const t = segLen > 1e-6 ? Math.min(1, Math.max(0, (v.s - r.cum[i]) / segLen)) : 0;
    const dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const off = this.twoWay(r, v.arc) ? RIGHT_OFFSET : 0;
    // правая нормаль к направлению (dx, dy) в системе «x — восток, y — север»: (dy, −dx)
    const x = x0 + dx * t + (dy / l) * off;
    const y = y0 + dy * t - (dx / l) * off;
    // азимут: 0° — север, по часовой стрелке
    const heading = (Math.atan2(dx, dy) * 180) / Math.PI;
    return { id: v.id, x, y, heading, v: v.v };
  }

  stats(): FleetStats {
    let sum = 0;
    for (const v of this.vehicles) sum += v.v;
    return { vehicles: this.vehicles.length, trips: this.trips, meanSpeed: this.vehicles.length ? sum / this.vehicles.length : 0, simTime: this.simTime };
  }
}
