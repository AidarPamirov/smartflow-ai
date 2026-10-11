import { bodyCorners, conflictTable, polysOverlap, type Conflict, type ConflictTable } from './conflicts';
import { ALL_RED, DETECTOR_ZONE, YELLOW, makeController, type Controller, type ControllerSpec, type PhaseObs } from './controllers';
import { DIRS, LANES_PER_APPROACH, MANEUVERS, STOP_S, lanesFor, type Dir, type LaneUse, type Maneuver } from './geometry';
import { Metrics, type Summary } from './metrics';
import { NO_UTURNS, buildPlan, validatePlan, type LeftMode, type MoveStatus, type Phase, type UturnAllowed } from './phases';
import { expInterval, mulberry32, streamSeed, type Rng } from './rng';
import { PATHS, V_FREE, approachLink, pathId, poseAt, vlimAt, type Path } from './routes';
import { B_YELLOW_DECIDE, IDM, STOP_SPEED, VEHICLE_LEN, idmAccel, type Vehicle } from './vehicle';

export type Flows = Record<Dir, number>; // авто/ч на подход
/** Веса выбора манёвра на въезде (доли или проценты — нормируются). */
export type TurnShares = Record<Maneuver, number>;
export type Turns = Record<Dir, TurnShares>;
/** G — защищённый зелёный, g — зелёный с уступкой, Y — жёлтый, R — красный. */
export type MoveLight = 'G' | 'g' | 'Y' | 'R';

export interface SignalState {
  phase: number; // индекс текущей (или последней) зелёной фазы в плане
  next: number; // фаза, которая включится после «все красные»
  stage: 'green' | 'yellow' | 'allred';
  elapsed: number;
  cycle: number; // счётчик жёлтых фаз
}

export interface SimConfig {
  seed: number;
  flows: Flows;
  controller: ControllerSpec;
  turns?: Turns;
  uturn?: UturnAllowed;
  leftMode?: LeftMode;
  /** Разметка полос (по умолчанию выделенная левая полоса). */
  laneUse?: LaneUse;
  /** Проверки безопасности на каждом шаге (зоны и пересечение кузовов). Включены по умолчанию. */
  diagnostics?: boolean;
}

export const DT = 0.1;
export const MAX_FLOW = 1500;
const SAMPLE_EVERY = 1.0;
/** Замедление, с которым водитель ещё может отказаться от въезда (точка принятия решения). */
const B_COMMIT = 2.5;
/** Запас времени при уступке: защищённая машина должна прибыть позже, чем уступающая освободит зону. */
export const GAP_MARGIN = 1.5;
/** Окно в начале жёлтого, когда первый стоящий левоповоротный может завершить манёвр. */
const SNEAK_WINDOW = 0.5;

export const DEFAULT_TURNS: TurnShares = { T: 70, L: 15, R: 15, U: 0 };
export const defaultTurns = (): Turns => ({ N: { ...DEFAULT_TURNS }, E: { ...DEFAULT_TURNS }, S: { ...DEFAULT_TURNS }, W: { ...DEFAULT_TURNS } });

interface Arrival { t: number; man: Maneuver }
interface ArrivalProc { rng: Rng; rate: number; nextT: number }

const laneKey = (d: Dir, l: number) => `${d}${l}`;

export function validateFlows(f: Flows): string | null {
  for (const d of DIRS) {
    const v = f[d];
    if (!Number.isFinite(v) || v < 0 || v > MAX_FLOW) return `Интенсивность должна быть от 0 до ${MAX_FLOW} авт/ч`;
  }
  return null;
}

export function validateTurns(t: Turns): string | null {
  for (const d of DIRS)
    for (const m of MANEUVERS) {
      const v = t[d][m];
      if (!Number.isFinite(v) || v < 0 || v > 100) return 'Доля манёвра должна быть от 0 до 100 %';
    }
  return null;
}

/** Эффективные вероятности с учётом запрета разворота. */
export function effectiveShares(s: TurnShares, uturnAllowed: boolean): TurnShares {
  const w = { ...s, U: uturnAllowed ? s.U : 0 };
  const sum = w.T + w.L + w.R + w.U;
  if (sum <= 0) return { T: 1, L: 0, R: 0, U: 0 };
  return { T: w.T / sum, L: w.L / sum, R: w.R / sum, U: w.U / sum };
}

/** Время, за которое машина со скоростью v проедет dist, разгоняясь с ускорением a до vcap. */
export function timeToCover(dist: number, v: number, vcap: number, a = IDM.a): number {
  if (dist <= 0) return 0;
  vcap = Math.max(vcap, 0.5);
  if (v >= vcap) return dist / v;
  const t1 = (vcap - v) / a, d1 = ((v + vcap) / 2) * t1;
  if (dist <= d1) return (-v + Math.sqrt(v * v + 2 * a * dist)) / a;
  return t1 + (dist - d1) / vcap;
}

export class Simulation {
  t = 0;
  private steps = 0;
  vehicles: Vehicle[] = [];
  /** Точечные очереди «за краем карты» по полосам въезда. */
  readonly backlog: Record<string, Arrival[]> = {};
  private arrivals: Record<Dir, ArrivalProc>;
  readonly turns: Turns;
  readonly uturn: UturnAllowed;
  readonly leftMode: LeftMode;
  readonly laneUse: LaneUse;
  readonly phases: Phase[];
  readonly conflicts: ConflictTable = conflictTable();
  signal: SignalState = { phase: 0, next: 0, stage: 'green', elapsed: 0, cycle: 0 };
  controller: Controller;
  metrics = new Metrics();
  generated = 0;
  generatedBy: Record<Maneuver, number> = { T: 0, L: 0, R: 0, U: 0 };
  readonly diagnostics: boolean;
  private nextId = 1;
  /** Отладочный журнал (только для диагностики в тестах). */
  debugLog?: (msg: string) => void;
  private byPath = new Map<string, Vehicle[]>();

  constructor(readonly config: SimConfig) {
    const err = validateFlows(config.flows);
    if (err) throw new Error(err);
    this.turns = config.turns ?? defaultTurns();
    const terr = validateTurns(this.turns);
    if (terr) throw new Error(terr);
    this.uturn = config.uturn ?? { ...NO_UTURNS };
    this.leftMode = config.leftMode ?? 'permissive';
    this.laneUse = config.laneUse ?? 'dedicated';
    this.diagnostics = config.diagnostics ?? true;
    this.phases = buildPlan(this.leftMode, this.uturn);
    const perr = validatePlan(this.phases);
    if (perr.length) throw new Error(`Некорректный план фаз: ${perr[0]}`);
    this.controller = makeController(config.controller);
    for (const d of DIRS) for (let l = 0; l < LANES_PER_APPROACH; l++) this.backlog[laneKey(d, l)] = [];
    for (const id of PATHS.keys()) this.byPath.set(id, []);
    this.arrivals = {} as Record<Dir, ArrivalProc>;
    DIRS.forEach((d, i) => {
      const rng = mulberry32(streamSeed(config.seed, i));
      const rate = config.flows[d];
      this.arrivals[d] = { rng, rate, nextT: expInterval(rng, rate) };
    });
  }

  // ───────────── управление извне ─────────────

  setFlow(dir: Dir, rate: number): void {
    const p = this.arrivals[dir];
    p.rate = rate;
    p.nextT = this.t + expInterval(p.rng, rate);
    this.config.flows[dir] = rate;
  }

  /** Доли манёвров можно менять на ходу; разрешение разворотов и режим левого — только при перезапуске. */
  setTurns(dir: Dir, shares: TurnShares): void {
    this.turns[dir] = { ...shares };
  }

  setController(spec: ControllerSpec): void {
    this.controller = makeController(spec);
    this.config.controller = spec;
  }

  // ───────────── состояние для UI и тестов ─────────────

  statusOf(pathIdStr: string, phaseIdx = this.signal.phase): MoveStatus | undefined {
    return this.phases[phaseIdx].status.get(pathIdStr);
  }

  /** Сигнал для маршрута. */
  lightOf(pathIdStr: string): MoveLight {
    const s = this.signal;
    if (s.stage === 'allred') return 'R';
    const st = this.statusOf(pathIdStr);
    if (!st) return 'R';
    if (s.stage === 'yellow') return 'Y';
    return st === 'P' ? 'G' : 'g';
  }

  currentPhase(): Phase {
    return this.phases[this.signal.phase];
  }

  allVehicles(): Vehicle[] {
    return this.vehicles;
  }

  backlogCount(dir: Dir): number {
    let n = 0;
    for (let l = 0; l < LANES_PER_APPROACH; l++) n += this.backlog[laneKey(dir, l)].length;
    return n;
  }

  inSystem(): number {
    let n = this.vehicles.length;
    for (const k in this.backlog) n += this.backlog[k].length;
    return n;
  }

  /** Очередь подхода: стоящие до стоп-линии + ожидающие въезда. */
  queueOf(dir: Dir): number {
    let n = this.backlogCount(dir);
    for (const v of this.vehicles) if (v.dir === dir && !v.crossed && v.v < STOP_SPEED) n++;
    return n;
  }

  queueByManeuver(): Record<Maneuver, number> {
    const q: Record<Maneuver, number> = { T: 0, L: 0, R: 0, U: 0 };
    for (const k in this.backlog) for (const a of this.backlog[k]) q[a.man]++;
    for (const v of this.vehicles) if (!v.crossed && v.v < STOP_SPEED) q[v.man]++;
    return q;
  }

  /** Конфликты маршрута, зоны которых сейчас удерживают машины с допуском. */
  heldZones(): { path: Path; c: Conflict }[] {
    const out: { path: Path; c: Conflict }[] = [];
    for (const v of this.vehicles) {
      if (!v.committed) continue;
      for (const c of this.conflicts.get(v.path.id)!) if (v.s <= c.b) out.push({ path: v.path, c });
    }
    return out;
  }

  observe(): PhaseObs[] {
    return this.phases.map((ph) => {
      const o: PhaseObs = { queue: 0, approaching: 0, maxWait: 0 };
      for (const v of this.vehicles) {
        if (v.crossed || !ph.status.has(v.path.id)) continue;
        if (v.v < STOP_SPEED) o.queue++;
        if (STOP_S - v.s <= DETECTOR_ZONE) o.approaching++;
        o.maxWait = Math.max(o.maxWait, v.wait);
      }
      for (const d of DIRS)
        for (let l = 0; l < LANES_PER_APPROACH; l++)
          for (const a of this.backlog[laneKey(d, l)])
            if (ph.status.has(pathId(d, l, a.man))) { o.queue++; o.maxWait = Math.max(o.maxWait, this.t - a.t); }
      return o;
    });
  }

  summary(): Summary {
    return this.metrics.summary(this.t, this.inSystem());
  }

  run(seconds: number): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step();
  }

  // ───────────── шаг симуляции ─────────────

  step(): void {
    const dt = DT;
    this.generateArrivals();
    this.spawn();
    this.updateSignal(dt);
    this.indexByPath();
    this.move(dt);
    this.removeExited(dt);
    if (this.diagnostics) this.checkSafety();
    this.t = +(this.t + dt).toFixed(6);
    this.steps++;
    if (this.steps % Math.round(SAMPLE_EVERY / dt) === 0) this.sample();
  }

  /** Три обращения к ГПСЧ на каждое прибытие — независимо от настроек, поэтому спрос воспроизводим. */
  private generateArrivals(): void {
    for (const d of DIRS) {
      const p = this.arrivals[d];
      while (p.nextT <= this.t) {
        const u1 = p.rng(), u2 = p.rng();
        const sh = effectiveShares(this.turns[d], this.uturn[d]);
        const man: Maneuver = u1 < sh.T ? 'T' : u1 < sh.T + sh.L ? 'L' : u1 < sh.T + sh.L + sh.R ? 'R' : 'U';
        const lanes = lanesFor(man, this.laneUse);
        const lane = lanes.length > 1 ? (u2 < 0.5 ? lanes[0] : lanes[1]) : lanes[0];
        this.backlog[laneKey(d, lane)].push({ t: p.nextT, man });
        this.generated++;
        this.generatedBy[man]++;
        p.nextT += expInterval(p.rng, p.rate);
      }
    }
  }

  private spawn(): void {
    for (const d of DIRS)
      for (let l = 0; l < LANES_PER_APPROACH; l++) {
        const queue = this.backlog[laneKey(d, l)];
        if (queue.length === 0) continue;
        let last: Vehicle | null = null;
        for (const v of this.vehicles) if (v.dir === d && v.lane === l && (!last || v.s < last.s)) last = v;
        const gap = last ? last.s - last.len : Infinity;
        if (gap < IDM.s0 + 1) continue;
        const v = last ? Math.max(0, Math.min(IDM.v0, last.v, (gap - IDM.s0) / IDM.T)) : IDM.v0;
        const arr = queue.shift()!;
        const waited = this.t - arr.t;
        const path = PATHS.get(pathId(d, l, arr.man))!;
        this.vehicles.push({
          id: this.nextId++, dir: d, lane: l, man: arr.man, path, s: 0, v, a: 0, len: VEHICLE_LEN,
          arriveT: arr.t, wait: waited > DT ? waited : 0, goOnYellow: -1, crossed: false, committed: false, blockedByYield: false,
        });
      }
  }

  private updateSignal(dt: number): void {
    const s = this.signal;
    s.elapsed += dt;
    if (s.stage === 'green') {
      const obs = this.observe();
      if (this.controller.shouldEndGreen(s.phase, s.elapsed, obs, this.phases)) {
        s.next = this.controller.nextPhase(s.phase, obs, this.phases);
        s.stage = 'yellow'; s.elapsed = 0; s.cycle++;
      }
    } else if (s.stage === 'yellow') {
      if (s.elapsed >= YELLOW - 1e-9) { s.stage = 'allred'; s.elapsed = 0; }
    } else if (s.elapsed >= ALL_RED - 1e-9) {
      s.phase = s.next; s.stage = 'green'; s.elapsed = 0;
    }
  }

  private indexByPath(): void {
    for (const arr of this.byPath.values()) arr.length = 0;
    for (const v of this.vehicles) this.byPath.get(v.path.id)!.push(v);
  }

  // ───────────── допуск на въезд ─────────────

  /** Удерживается ли зона конфликта c (с маршрутом c.other) машиной с допуском или находящейся в ней. */
  private zoneHolder(c: Conflict): Vehicle | null {
    for (const w of this.byPath.get(c.other)!) {
      if (w.committed && w.s <= c.ob) return w;
      if (w.s >= c.oa && w.s <= c.ob) return w;
    }
    return null;
  }

  /**
   * Попытка получить допуск. Условия: (1) въезжает первой в своей полосе;
   * (2) все конфликтные зоны свободны; (3) уступающий маршрут видит достаточный интервал
   * у защищённых конфликтующих потоков. При успехе машина удерживает все свои зоны.
   */
  private tryCommit(veh: Vehicle): boolean {
    for (const o of this.vehicles)
      if (o !== veh && o.dir === veh.dir && o.lane === veh.lane && !o.committed && !o.crossed && o.s > veh.s) return false;
    const cs = this.conflicts.get(veh.path.id)!;
    for (const c of cs) {
      const holder = this.zoneHolder(c);
      if (holder) {
        // учёт: защищённая машина ждёт уступающую, которая уже заняла зону (считается один раз на машину)
        if (!veh.blockedByYield && this.lightOf(veh.path.id) === 'G' && this.statusOf(holder.path.id) === 'Y' && c.kind !== 'diverge') {
          veh.blockedByYield = true;
          this.metrics.safety.priorityBlocked++;
        }
        return false;
      }
    }
    if (this.statusOf(veh.path.id) === 'Y') {
      const yellow = this.signal.stage === 'yellow';
      const vcapSelf = Math.min(V_FREE, veh.path.vCurveMin + 1);
      for (const c of cs) {
        if (c.kind === 'diverge' || this.statusOf(c.other) !== 'P') continue;
        const tNeed = timeToCover(c.b - veh.s, veh.v, vcapSelf) + GAP_MARGIN;
        for (const w of this.byPath.get(c.other)!) {
          if (w.crossed || w.committed) continue;
          if (yellow && w.goOnYellow !== this.signal.cycle) continue; // остановится на жёлтый
          const tw = timeToCover(c.oa - w.s, w.v, V_FREE);
          if (tw < tNeed) return false;
        }
      }
    }
    veh.committed = true;
    return true;
  }

  /** Должна ли машина сейчас остановиться у стоп-линии (стоп-линия как препятствие). */
  private mustStop(veh: Vehicle): boolean {
    if (veh.crossed) return false;
    const light = this.lightOf(veh.path.id);
    const d = STOP_S - veh.s;
    if (light === 'R') { veh.committed = false; return true; }
    if (light === 'Y') {
      if (veh.goOnYellow !== this.signal.cycle) {
        const canStop = (veh.v * veh.v) / (2 * B_YELLOW_DECIDE) <= d + 0.5;
        if (veh.committed && d < 1.0) { veh.goOnYellow = this.signal.cycle; return false; } // уже въезжает
        if (canStop) {
          // «Завершение поворота на жёлтый»: первая стоящая у линии уступающая машина
          const sneak = this.statusOf(veh.path.id) === 'Y' && veh.v < 1 && d < 1.5 && this.signal.elapsed < SNEAK_WINDOW;
          if (sneak && (veh.committed || this.tryCommit(veh))) { veh.goOnYellow = this.signal.cycle; return false; }
          veh.committed = false;
          return true;
        }
        veh.goOnYellow = this.signal.cycle;
      }
      return !(veh.committed || this.tryCommit(veh));
    }
    if (veh.committed) return false;
    const commitDist = (veh.v * veh.v) / (2 * B_COMMIT) + veh.v * 1.0 + 2;
    if (d > commitDist) return false;
    return !this.tryCommit(veh);
  }

  // ───────────── движение ─────────────

  private linkIdx(p: Path, s: number): number {
    return s < p.connStart ? 0 : s < p.connEnd ? 1 : 2;
  }

  /**
   * Лидер — ближайшая машина впереди на общем участке пути (та же полоса въезда,
   * тот же соединитель или та же полоса выезда). Возвращает смещение координат его пути в мои.
   */
  private findLeader(me: Vehicle, occ: Map<string, Vehicle[]>): { o: Vehicle; off: number; gap: number } | null {
    let best: { o: Vehicle; off: number; gap: number } | null = null;
    const seen = new Set<number>();
    for (const link of me.path.links) {
      const list = occ.get(link);
      if (!list) continue;
      for (const o of list) {
        if (o === me || seen.has(o.id)) continue;
        seen.add(o.id);
        let off: number | null = null;
        for (const s of [o.s - o.len, o.s]) {
          const oi = this.linkIdx(o.path, s);
          const mi = me.path.links.indexOf(o.path.links[oi]);
          if (mi >= 0) { off = me.path.linkStart[mi] - o.path.linkStart[oi]; break; }
        }
        if (off === null) continue;
        const front = o.s + off;
        if (front <= me.s + 1e-6) continue;
        const gap = front - o.len - me.s;
        if (!best || gap < best.gap) best = { o, off, gap };
      }
    }
    return best;
  }

  private move(dt: number): void {
    const occ = new Map<string, Vehicle[]>();
    const add = (k: string, v: Vehicle) => { const l = occ.get(k); if (l) l.push(v); else occ.set(k, [v]); };
    for (const v of this.vehicles) {
      const a = v.path.links[this.linkIdx(v.path, v.s - v.len)], b = v.path.links[this.linkIdx(v.path, v.s)];
      add(a, v);
      if (b !== a) add(b, v);
    }
    const n = this.vehicles.length;
    const leaders: ({ o: Vehicle; off: number } | null)[] = new Array(n);
    const stops: boolean[] = new Array(n);
    const prevS = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const veh = this.vehicles[i];
      // предел скорости по всему кузову: перёд уже на прямой, а середина ещё в повороте
      const v0 = Math.min(IDM.v0, vlimAt(veh.path, veh.s), vlimAt(veh.path, veh.s - veh.len / 2), vlimAt(veh.path, veh.s - veh.len));
      const L = this.findLeader(veh, occ);
      let a = L ? idmAccel(veh.v, L.gap, veh.v - L.o.v, v0) : idmAccel(veh.v, Infinity, 0, v0);
      if (L) this.metrics.safety.minGap = Math.min(this.metrics.safety.minGap, L.gap);
      leaders[i] = L;
      const stop = this.mustStop(veh);
      stops[i] = stop;
      if (stop) a = Math.min(a, idmAccel(veh.v, STOP_S - veh.s + IDM.s0 - 0.5, veh.v, v0));
      // явное слежение за профилем допустимой скорости на кривой (профиль уже учитывает торможение ≤ B_CURVE)
      const sn = veh.s + veh.v * DT;
      const vNext = Math.min(vlimAt(veh.path, sn), vlimAt(veh.path, sn - veh.len / 2), vlimAt(veh.path, sn - veh.len));
      if (veh.v > vNext) a = Math.min(a, Math.max(-IDM.bMax, (vNext - veh.v) / DT));
      veh.a = a;
      prevS[i] = veh.s;
    }
    for (let i = 0; i < n; i++) {
      const veh = this.vehicles[i];
      let nv = veh.v + veh.a * dt;
      let ds: number;
      if (nv < 0) { ds = veh.a < 0 ? (veh.v * veh.v) / (-2 * veh.a) : 0; nv = 0; }
      else ds = ((veh.v + nv) / 2) * dt;
      veh.s += ds; veh.v = nv;
    }
    // ограничения (не должны срабатывать — считаются как сбой модели)
    for (let i = 0; i < n; i++) {
      const veh = this.vehicles[i];
      if (stops[i] && veh.s > STOP_S) { this.debugLog?.(`stop-clamp ${veh.path.id} v=${veh.v.toFixed(2)} prev=${prevS[i].toFixed(2)} light=${this.lightOf(veh.path.id)} stage=${this.signal.stage} el=${this.signal.elapsed.toFixed(1)} committed=${veh.committed} goY=${veh.goOnYellow === this.signal.cycle}`); veh.s = Math.max(prevS[i], STOP_S); veh.v = 0; this.metrics.safety.interventions++; }
      const L = leaders[i];
      if (L) {
        const limit = L.o.s + L.off - L.o.len - 0.3;
        if (veh.s > limit) { this.debugLog?.(`leader-clamp ${veh.path.id} behind ${L.o.path.id} gap=${(L.o.s + L.off - L.o.len - veh.s).toFixed(2)} v=${veh.v.toFixed(1)} lv=${L.o.v.toFixed(1)}`); veh.s = Math.max(prevS[i], limit); veh.v = Math.min(veh.v, L.o.v); this.metrics.safety.interventions++; }
      }
      if (!veh.crossed && prevS[i] <= STOP_S && veh.s > STOP_S) {
        veh.crossed = true;
        if (this.lightOf(veh.path.id) === 'R') this.metrics.safety.redViolations++;
      }
      if (veh.v < STOP_SPEED) veh.wait += dt;
    }
  }

  private removeExited(dt: number): void {
    const keep: Vehicle[] = [];
    for (const v of this.vehicles) {
      if (v.s - v.len > v.path.length) {
        const travel = this.t + dt - v.arriveT;
        this.metrics.recordServed(v.man, v.wait, travel - v.path.freeTime);
      } else keep.push(v);
    }
    this.vehicles = keep;
  }

  /** Независимые проверки: (1) две машины конфликтующих маршрутов в общей зоне; (2) пересечение кузовов. */
  private checkSafety(): void {
    const near = this.vehicles.filter((v) => v.s > v.path.connStart - 6 && v.s - v.len < v.path.connEnd + 6);
    let zone = false;
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j];
        const pa = poseAt(a.path, a.s - a.len / 2), pb = poseAt(b.path, b.s - b.len / 2);
        if (Math.abs(pa.x - pb.x) < 6 && Math.abs(pa.y - pb.y) < 6 && polysOverlap(bodyCorners(a.path, a.s), bodyCorners(b.path, b.s)))
          this.metrics.safety.overlaps++;
        if (a.path.id === b.path.id) continue;
        const c = this.conflicts.get(a.path.id)!.find((x) => x.other === b.path.id);
        if (c && a.s >= c.a && a.s <= c.b && b.s >= c.oa && b.s <= c.ob) zone = true;
      }
    if (zone) this.metrics.safety.zoneViolations++;
  }

  private sample(): void {
    const byDir = {} as Record<Dir, number>;
    for (const d of DIRS) byDir[d] = this.queueOf(d);
    const byMan = this.queueByManeuver();
    this.metrics.recordQueues(byDir, byMan);
    this.metrics.samples.push({ t: Math.round(this.t), queue: byMan, served: this.metrics.served, avgWait: this.metrics.avgWait });
  }
}

export { approachLink };
