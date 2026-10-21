/**
 * Обработка виртуальных камер по синтетическому трафику модели (без видео и без компьютерного зрения).
 *
 * Камеры получают от симулятора то же, что получила бы откалиброванная камера: положения машин на дороге
 * в метрах и время. Из этого считаются:
 *  - поток: машины, пересёкшие линию подсчёта, авт/ч; средняя скорость в момент пересечения (её даёт симулятор);
 *    плотность на 100 м перед линией, авт/км; занятость зоны детектора (доля времени); очередь; затор;
 *  - скорость: время между двумя линиями на известном расстоянии (участковый метод, 100 м); превышение
 *    демонстрационного ограничения с допуском;
 *  - сплошная линия: пересечение линии, заданной в координатах дороги, отрезком траектории машины;
 *  - ремень: модели нет — оценка всегда «невозможно определить», камера помечена как визуальный макет.
 * Машины анонимны: в событиях — номер в пределах сеанса, без номеров и изображений.
 */
import type { ApproachObs, Vehicle, VehiclePose } from '../traffic/fleet';
import type { Network } from '../traffic/network';
import type { SignalSystem } from '../signals/system';
import { crossPolyline, crossingTime, percentile, sectionSpeed, type XY } from './geometry';
import { SPEED_SECTION, arcSlice, placeCameras } from './placement';
import { EVENT_NOTE, type Camera, type CameraEvent, type CameraSettings, type ConnStatus } from './types';

export const WINDOW_S = 300;
export const SPEED_WINDOW_S = 120;
export const EVENTS_KEPT = 30;
export const QUEUE_CONGESTED = 5;
const STOPPED = 0.5;

const arcKey = (edge: number, forward: boolean) => edge * 2 + (forward ? 0 : 1);
/** Анонимный номер машины в сеансе (без связи с реальными людьми). */
export const anonId = (id: number) => `v-${((id * 2654435761) >>> 0).toString(16).slice(-4)}`;

export interface CameraMetrics {
  windowS: number;
  /** поток */
  flowVehH: number | null;
  meanSpeedKmh: number | null;
  densityVehKm: number | null;
  occupancy: number | null;
  queue: number | null;
  congested: boolean;
  /** скорость */
  measured: number;
  meanKmh: number | null;
  p85Kmh: number | null;
  maxKmh: number | null;
  violations: number;
  /** линия */
  crossings: number;
  /** ремень и пройденные машины */
  passes: number;
}

interface CamState {
  cross: { t: number; kmh: number }[];
  speeds: { t: number; kmh: number }[];
  enter: Map<number, number>;
  occ: number;
  density: number;
  congested: boolean;
  violations: number;
  crossings: number;
  passes: number;
  events: CameraEvent[];
  totalEvents: number;
  line: XY[] | null;
}

export class CameraSystem {
  readonly cameras: Camera[];
  private st: CamState[];
  private byArc = new Map<number, number[]>();
  private lineEdges = new Map<number, number[]>();
  private prev = new Map<number, { route: Vehicle['route']; s: number; arc: number; xy: XY | null }>();
  t = 0;
  /** Есть ли поток данных (трафик загружен и идёт). */
  live = false;

  constructor(private net: Network, cameras?: Camera[], sys?: SignalSystem) {
    if (!cameras && !sys) throw new Error('нужны камеры или сеть светофоров для расстановки');
    this.cameras = cameras ?? placeCameras(net, sys!);
    this.st = this.cameras.map((c) => ({
      cross: [], speeds: [], enter: new Map(), occ: 0, density: 0, congested: false, violations: 0, crossings: 0, passes: 0,
      events: [], totalEvents: 0,
      line: c.type === 'line' ? arcSlice(net, c.edge, c.forward, c.marks[0], c.marks[1]) : null,
    }));
    this.cameras.forEach((c, i) => {
      if (c.type === 'line') {
        const a = this.lineEdges.get(c.edge);
        if (a) a.push(i); else this.lineEdges.set(c.edge, [i]);
      } else {
        const k = arcKey(c.edge, c.forward);
        const a = this.byArc.get(k);
        if (a) a.push(i); else this.byArc.set(k, [i]);
      }
    });
  }

  reset() {
    this.t = 0;
    this.prev.clear();
    for (const s of this.st) {
      s.cross = []; s.speeds = []; s.enter.clear(); s.occ = 0; s.density = 0; s.congested = false;
      s.violations = 0; s.crossings = 0; s.passes = 0; s.events = []; s.totalEvents = 0;
    }
  }

  setSettings(i: number, patch: Partial<CameraSettings>) {
    const c = this.cameras[i];
    if (!c) return;
    c.settings = { ...c.settings, ...patch };
  }

  status(i: number): ConnStatus {
    const c = this.cameras[i];
    if (c.dataMode === 'mock' || !c.settings.enabled) return 'offline';
    return this.live ? 'online' : 'no_data';
  }

  events(i: number): CameraEvent[] { return this.st[i].events.slice().reverse(); }
  totalEvents(i: number): number { return this.st[i].totalEvents; }
  line(i: number): XY[] | null { return this.st[i].line; }

  private emit(i: number, e: Omit<CameraEvent, 't'>, t: number) {
    const s = this.st[i];
    s.events.push({ ...e, t: Math.round(t * 10) / 10 });
    if (s.events.length > EVENTS_KEPT) s.events.splice(0, s.events.length - EVENTS_KEPT);
    s.totalEvents++;
  }

  /**
   * Кадр обработки: машины переместились за dt секунд модели.
   * @param pose положение машины в метрах (для камер линии)
   * @param approach очереди у светофоров по ключу въезда (если подключены светофоры)
   */
  process(vehicles: readonly Vehicle[], pose: (v: Vehicle) => VehiclePose, dt: number, approach?: Map<number, ApproachObs>) {
    const t0 = this.t, t1 = this.t + dt;
    this.t = t1;
    this.live = true;
    if (dt <= 0) return;
    const nextPrev = new Map<number, { route: Vehicle['route']; s: number; arc: number; xy: XY | null }>();
    /** Положения машин на ребрах с камерами потока: ключ → [локальная отметка, скорость]. */
    const onArc = new Map<number, [number, number][]>();
    for (const v of vehicles) {
      const r = v.route;
      const a = r.arcs[v.arc];
      const key = arcKey(a.edge, a.forward);
      if (this.byArc.has(key)) {
        const list = onArc.get(key);
        const item: [number, number] = [v.s - r.arcStart[v.arc], v.v];
        if (list) list.push(item); else onArc.set(key, [item]);
      }
      const p = this.prev.get(v.id);
      // линии подсчёта и участки скорости
      if (p && p.route === r && v.s > p.s) {
        for (let i = p.arc; i <= v.arc; i++) {
          const ai = r.arcs[i];
          const cams = this.byArc.get(arcKey(ai.edge, ai.forward));
          if (!cams) continue;
          for (const ci of cams) {
            const c = this.cameras[ci];
            if (!c.settings.enabled) continue;
            c.marks.forEach((m, mi) => {
              const tc = crossingTime(p.s, v.s, r.arcStart[i] + m, t0, t1);
              if (tc !== null) this.onMark(ci, mi, tc, v);
            });
          }
        }
      }
      // камеры линии: только машины на рёбрах с такими камерами
      let xy: XY | null = null;
      const lineCams = this.lineEdges.get(a.edge) ?? (p ? this.lineEdges.get(r.arcs[p.arc]?.edge ?? -1) : undefined);
      if (lineCams) {
        const ps = pose(v);
        xy = [ps.x, ps.y];
        if (p?.xy && p.route === r) {
          for (const ci of lineCams) {
            const c = this.cameras[ci];
            if (!c.settings.enabled) continue;
            const hit = crossPolyline(p.xy, xy, this.st[ci].line!);
            if (!hit) continue;
            const depth = distToPolyline(xy, this.st[ci].line!);
            const sure = depth >= c.settings.sensitivity;
            const conf = sure ? 1 : 0.5;
            this.st[ci].crossings++;
            const ok = conf >= c.settings.confidenceThreshold;
            this.emit(ci, {
              kind: ok ? 'line_crossing' : 'insufficient_data', vehicle: anonId(v.id), value: Math.round(depth * 10) / 10, confidence: conf,
              text: ok ? `пересечение линии (${hit.dir === 'left_to_right' ? 'слева направо' : 'справа налево'}), заезд ${depth.toFixed(1)} м` : `касание линии ${depth.toFixed(1)} м — недостаточно для вывода`,
            }, t0 + hit.t * dt);
          }
        }
      }
      nextPrev.set(v.id, { route: r, s: v.s, arc: v.arc, xy });
    }
    this.prev = nextPrev;

    // занятость, плотность, очереди, заторы — для камер потока
    const k = Math.min(1, dt / WINDOW_S);
    this.cameras.forEach((c, i) => {
      if (c.type !== 'flow' || !c.settings.enabled) return;
      const s = this.st[i];
      const m = c.marks[0];
      const list = onArc.get(arcKey(c.edge, c.forward)) ?? [];
      const occupied = list.some(([pos]) => pos >= m - 2.5 && pos <= m + 7) ? 1 : 0;
      s.occ += (occupied - s.occ) * k;
      const dens = list.filter(([pos]) => pos <= m && pos >= m - 100).length / 0.1;
      s.density += (dens - s.density) * k;
      const q = this.queueAt(i, approach, list);
      const recent = s.cross.filter((x) => x.t >= this.t - SPEED_WINDOW_S);
      const mean = recent.length >= 3 ? recent.reduce((a, x) => a + x.kmh, 0) / recent.length : null;
      const thr = c.settings.sensitivity;
      if (!s.congested && mean !== null && mean < thr && q >= QUEUE_CONGESTED) {
        s.congested = true;
        this.emit(i, { kind: 'congestion', vehicle: null, value: Math.round(mean), confidence: 1, text: `затор: средняя скорость ${Math.round(mean)} км/ч < ${thr}, очередь ${q}` }, this.t);
      } else if (s.congested && (mean === null || mean > thr + 5) && q < QUEUE_CONGESTED) {
        s.congested = false;
        this.emit(i, { kind: 'congestion_end', vehicle: null, value: mean === null ? null : Math.round(mean), confidence: 1, text: 'затор рассосался' }, this.t);
      }
    });
  }

  private queueAt(i: number, approach: Map<number, ApproachObs> | undefined, list: [number, number][]): number {
    const c = this.cameras[i];
    if (c.signal >= 0 && approach) return approach.get(arcKey(c.edge, c.forward))?.queue ?? 0;
    return list.filter(([pos, v]) => v < STOPPED && pos >= c.marks[0] - 150).length;
  }

  private onMark(ci: number, mi: number, tc: number, v: Vehicle) {
    const c = this.cameras[ci];
    const s = this.st[ci];
    if (c.type === 'seatbelt') { s.passes++; return; }
    if (c.type === 'flow') {
      s.cross.push({ t: tc, kmh: v.v * 3.6 });
      s.passes++;
      const cut = this.t - WINDOW_S;
      while (s.cross.length && s.cross[0].t < cut) s.cross.shift();
      return;
    }
    // скорость: отметка 0 — въезд на участок, 1 — выезд
    if (mi === 0) { s.enter.set(v.id, tc); return; }
    const te = s.enter.get(v.id);
    s.enter.delete(v.id);
    if (te === undefined) return; // въезд не зафиксирован (машина появилась на участке) — скорость не определена
    const sp = sectionSpeed(c.marks[1] - c.marks[0], te, tc);
    if (sp === null) return;
    const kmh = sp * 3.6;
    s.speeds.push({ t: tc, kmh });
    s.passes++;
    const cut = this.t - WINDOW_S;
    while (s.speeds.length && s.speeds[0].t < cut) s.speeds.shift();
    if (kmh > c.limitKmh + c.settings.sensitivity) {
      s.violations++;
      this.emit(ci, { kind: 'speeding', vehicle: anonId(v.id), value: Math.round(kmh * 10) / 10, confidence: 1, text: `${kmh.toFixed(1)} км/ч при ограничении ${c.limitKmh} (+${c.settings.sensitivity} допуск), участок ${SPEED_SECTION} м` }, tc);
    }
  }

  metrics(i: number, approach?: Map<number, ApproachObs>): CameraMetrics {
    const c = this.cameras[i];
    const s = this.st[i];
    const span = Math.min(WINDOW_S, this.t);
    const base: CameraMetrics = {
      windowS: Math.round(span), flowVehH: null, meanSpeedKmh: null, densityVehKm: null, occupancy: null, queue: null, congested: false,
      measured: 0, meanKmh: null, p85Kmh: null, maxKmh: null, violations: s.violations, crossings: s.crossings, passes: s.passes,
    };
    if (!this.live || !c.settings.enabled || c.dataMode === 'mock') return base;
    if (c.type === 'flow') {
      const cross = s.cross.filter((x) => x.t >= this.t - WINDOW_S);
      return {
        ...base,
        flowVehH: span >= 30 ? Math.round((cross.length / span) * 3600) : null,
        meanSpeedKmh: cross.length ? Math.round((cross.reduce((a, x) => a + x.kmh, 0) / cross.length) * 10) / 10 : null,
        densityVehKm: Math.round(s.density * 10) / 10,
        occupancy: Math.round(s.occ * 1000) / 1000,
        queue: c.signal >= 0 && approach ? (approach.get(arcKey(c.edge, c.forward))?.queue ?? 0) : null,
        congested: s.congested,
      };
    }
    if (c.type === 'speed') {
      const sp = s.speeds.filter((x) => x.t >= this.t - WINDOW_S).map((x) => x.kmh);
      const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
      return { ...base, measured: sp.length, meanKmh: r1(sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null), p85Kmh: r1(percentile(sp, 0.85)), maxKmh: r1(sp.length ? Math.max(...sp) : null) };
    }
    return base;
  }

  static readonly note = EVENT_NOTE;
}

/** Расстояние от точки до ломаной, м. */
export function distToPolyline(p: XY, line: readonly XY[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (ax + dx * t), p[1] - (ay + dy * t)));
  }
  return best;
}
