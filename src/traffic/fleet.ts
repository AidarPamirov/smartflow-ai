/**
 * Движение синтетических машин по готовым маршрутам.
 * Не знает ни о карте, ни о том, как строятся маршруты: получает их из пула.
 *
 * Модель намеренно простая: разгон и торможение, снижение скорости перед поворотами,
 * дистанция до машины впереди на той же дуге. Если подключены светофоры (SignalHook), машина останавливается
 * перед регулируемым въездом на красный и на жёлтый, если успевает остановиться. Приоритета между
 * направлениями внутри перекрёстка нет: машины разных фаз не пересекаются только потому, что едут в разное время.
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
/** Стоп-линия — за столько метров до узла графа (центра пересечения проезжих частей). */
export const STOP_BACK = 12;
/** Машина считается стоящей в очереди при скорости ниже, м/с. */
export const QUEUE_SPEED = 0.5;
/** Очередь и подъезжающие считаются в пределах, м до стоп-линии. */
export const QUEUE_RANGE = 150;
export const DETECTOR_RANGE = 40;

/** Светофоры для демо-трафика: какие въезды регулируются и какой на них сигнал. */
export interface SignalHook {
  /** Регулируется ли въезд по направленному участку (ключ edge × 2 + (forward ? 0 : 1)). */
  controlled(arcKey: number): boolean;
  /** Сигнал на въезде; 'off' — светофор выключен (въезд без регулирования). */
  light(arcKey: number): 'G' | 'Y' | 'R' | 'off' | null;
}

/** Наблюдения у одного регулируемого въезда. */
export interface ApproachObs { queue: number; approaching: number; maxWait: number }

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
  /** Сколько секунд машина стоит (скорость < QUEUE_SPEED); сбрасывается, когда едет. */
  wait: number;
  /** Ближайший регулируемый въезд впереди: ключ участка (-1 — нет в пределах QUEUE_RANGE) и расстояние до стоп-линии, м. */
  stopKey: number;
  stopD: number;
  /** Решение на жёлтый: номер участка маршрута, на котором машина решила проехать (не успевает остановиться). */
  goArc: number;
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
    private signals?: SignalHook,
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
      const v: Vehicle = { id: this.nextId++, route, s, v: 0, k: 0.85 + this.rng() * 0.2, seg: 0, arc: 0, wait: 0, stopKey: -1, stopD: Infinity, goArc: -1 };
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

  /** Подключить или отключить светофоры. */
  setSignals(hook: SignalHook | undefined) {
    this.signals = hook;
    for (const v of this.vehicles) { v.stopKey = -1; v.stopD = Infinity; v.goArc = -1; }
  }

  /** Ближайший регулируемый въезд впереди в пределах QUEUE_RANGE: [индекс дуги маршрута, расстояние до стоп-линии]. */
  private nextStop(v: Vehicle): [number, number] {
    const h = this.signals;
    if (!h) return [-1, Infinity];
    const r = v.route;
    for (let i = v.arc; i < r.arcs.length; i++) {
      if (r.arcStart[i] - v.s > QUEUE_RANGE) break;
      const a = r.arcs[i];
      if (!h.controlled(a.edge * 2 + (a.forward ? 0 : 1))) continue;
      const end = i + 1 < r.arcs.length ? r.arcStart[i + 1] : r.length;
      const stop = end - Math.min(STOP_BACK, (end - r.arcStart[i]) * 0.5);
      const d = stop - v.s;
      if (d < -0.01) continue; // уже за стоп-линией этого въезда
      if (d > QUEUE_RANGE) break;
      return [i, d];
    }
    return [-1, Infinity];
  }

  /** Допустимая скорость с учётом ближайших точек впереди (успеть затормозить до них) и сигнала светофора. */
  private limitAt(v: Vehicle): number {
    const r = v.route;
    let lim = r.vmax[v.seg] * v.k;
    const horizon = (v.v * v.v) / (2 * DECEL) + 15;
    for (let i = v.seg + 1; i < r.cum.length; i++) {
      const d = r.cum[i] - v.s;
      if (d > horizon) break;
      lim = Math.min(lim, Math.sqrt(r.vmax[i] * r.vmax[i] + 2 * DECEL * Math.max(0, d - 1)));
    }
    const [ai, d] = this.nextStop(v);
    v.stopKey = ai >= 0 ? r.arcs[ai].edge * 2 + (r.arcs[ai].forward ? 0 : 1) : -1;
    v.stopD = d;
    if (ai >= 0 && this.mustStop(v, ai, d)) lim = Math.min(lim, Math.sqrt(2 * DECEL * Math.max(0, d - 0.5)));
    return lim;
  }

  /** Стоять ли перед стоп-линией: красный — да; жёлтый — если успевает остановиться (решение «ехать» запоминается). */
  private mustStop(v: Vehicle, ai: number, d: number): boolean {
    const light = this.signals!.light(v.stopKey);
    if (light === 'R') return v.goArc !== ai; // решил ехать на жёлтый — завершает проезд («все красные» дают на это время)
    if (light === 'Y') {
      if (v.goArc === ai) return false;
      if ((v.v * v.v) / (2 * DECEL) <= d + 0.5) return true;
      v.goArc = ai;
      return false;
    }
    return false;
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
      // не пересекать стоп-линию на запрещающий сигнал из-за дискретного шага
      if (v.stopKey >= 0 && ds > v.stopD) {
        const ai = this.stopArc(v);
        if (ai >= 0 && this.mustStop(v, ai, v.stopD)) { ds = Math.max(0, v.stopD); v.v = 0; }
      }
      v.wait = v.v < QUEUE_SPEED ? v.wait + dt : 0;
      v.s += ds;
      if (v.s >= v.route.length) {
        // поездка завершена: следующая начинается там же, где закончилась эта (если удалось построить)
        this.trips++;
        const over = v.s - v.route.length;
        v.route = this.continueFrom?.(v.route.to) ?? this.pick();
        v.s = Math.min(over, v.route.length * 0.5);
        v.seg = 0;
        v.v = Math.min(v.v, v.route.vmax[0]);
        v.goArc = -1;
        v.stopKey = -1;
        v.stopD = Infinity;
      }
      this.locate(v);
    }
    this.simTime += dt;
  }

  /** Индекс дуги маршрута, к стоп-линии которой едет машина (по последнему расчёту limitAt). */
  private stopArc(v: Vehicle): number {
    const r = v.route;
    for (let i = v.arc; i < r.arcs.length; i++) if (r.arcs[i].edge * 2 + (r.arcs[i].forward ? 0 : 1) === v.stopKey) return i;
    return -1;
  }

  /** Очереди и подъезжающие у каждого регулируемого въезда (по ключу участка). */
  approachObs(): Map<number, ApproachObs> {
    const out = new Map<number, ApproachObs>();
    for (const v of this.vehicles) {
      if (v.stopKey < 0 || v.stopD > QUEUE_RANGE) continue;
      let o = out.get(v.stopKey);
      if (!o) { o = { queue: 0, approaching: 0, maxWait: 0 }; out.set(v.stopKey, o); }
      if (v.v < QUEUE_SPEED) { o.queue++; o.maxWait = Math.max(o.maxWait, v.wait); }
      else if (v.stopD <= DETECTOR_RANGE) o.approaching++;
    }
    return out;
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
