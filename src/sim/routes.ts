import {
  APPROACH, DIRS, EXIT_LEN, MANEUVERS, entryPoint, exitLaneFor, exitPoint, exitSide, heading,
  headingAfter, allLanesFor, spawnPoint, type Dir, type Maneuver, type Vec,
} from './geometry';

/**
 * Маршрут (movement) = въездная полоса + соединитель в зоне перекрёстка + полоса выезда.
 * Путь хранится как ломаная, равномерно разбитая по длине дуги (шаг DS),
 * с направлением, кривизной и допустимой скоростью в каждой точке.
 */
export const DS = 0.25;
/** Допустимое боковое ускорение на кривой, м/с². */
export const A_LAT = 2.5;
/** Замедление, которым водитель заранее снижает скорость перед кривой, м/с². */
export const B_CURVE = 2.0;
export const V_FREE = 13.9;

export interface Path {
  id: string; // напр. "N0L"
  dir: Dir;
  lane: number;
  man: Maneuver;
  exitSide: Dir;
  exitLane: number;
  /** Идентификаторы участков: въезд, соединитель, выезд. */
  links: [string, string, string];
  /** Начало каждого участка в координате s этого пути. */
  linkStart: [number, number, number];
  connStart: number; // = APPROACH
  connEnd: number;
  length: number;
  xs: Float64Array; ys: Float64Array; hs: Float64Array;
  /** Предвидимый предел скорости: учитывает торможение перед будущими кривыми. */
  vlim: Float64Array;
  /** Минимальная скорость кривизны на соединителе (для оценок времени проезда). */
  vCurveMin: number;
  /** Время свободного проезда всего пути, с. */
  freeTime: number;
}

export const approachLink = (d: Dir, lane: number) => `A:${d}${lane}`;
export const exitLink = (side: Dir, lane: number) => `X:${side}${lane}`;

function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Контрольные точки соединителя. Для поворотов — аппроксимация дуги окружности (k = 0,5523·R). */
export function connectorControls(dir: Dir, lane: number, man: Maneuver): [Vec, Vec, Vec, Vec] {
  const h0 = heading(dir), h1 = headingAfter(dir, man);
  const p0 = entryPoint(dir, lane), p3 = exitPoint(h1, exitLaneFor(man, lane));
  let k0: number, k1: number;
  if (man === 'T') {
    const L = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    k0 = k1 = L / 3;
  } else if (man === 'U') {
    k0 = k1 = 0; // не используется: разворот строится дугой (sampleUturn)
  } else {
    // угол пересечения касательных
    const corner = Math.abs(h0.x) > 0.5 ? { x: p3.x, y: p0.y } : { x: p0.x, y: p3.y };
    const R0 = Math.hypot(corner.x - p0.x, corner.y - p0.y), R1 = Math.hypot(corner.x - p3.x, corner.y - p3.y);
    k0 = 0.5523 * R0; k1 = 0.5523 * R1;
  }
  return [p0, { x: p0.x + h0.x * k0, y: p0.y + h0.y * k0 }, { x: p3.x - h1.x * k1, y: p3.y - h1.y * k1 }, p3];
}

/** Ломаная по кривой Безье, равномерная по длине дуги. */
function sampleBezier(c: [Vec, Vec, Vec, Vec]): Vec[] {
  const N = 2000;
  const dense: Vec[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= N; i++) {
    const p = bezier(c[0], c[1], c[2], c[3], i / N);
    if (i > 0) cum.push(cum[i - 1] + Math.hypot(p.x - dense[i - 1].x, p.y - dense[i - 1].y));
    dense.push(p);
  }
  const total = cum[N];
  const n = Math.max(1, Math.round(total / DS));
  const out: Vec[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (j < N - 1 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = (target - cum[j]) / seg;
    out.push({ x: dense[j].x + (dense[j + 1].x - dense[j].x) * f, y: dense[j].y + (dense[j + 1].y - dense[j].y) * f });
  }
  return out;
}

function sampleLine(a: Vec, b: Vec, len: number): Vec[] {
  const n = Math.round(len / DS);
  const out: Vec[] = [];
  for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  return out;
}

/** Разворот: заезд вглубь на U_DEPTH, полуокружность радиусом U_R, выезд обратно. */
export const U_DEPTH = 6;
export const U_R = 3.5; // = половина расстояния между полосой 0 въезда и полосой 1 выезда
function sampleUturn(dir: Dir, lane: number): Vec[] {
  const h = heading(dir), L = { x: h.y, y: -h.x };
  const p0 = entryPoint(dir, lane);
  const S = { x: p0.x + h.x * U_DEPTH, y: p0.y + h.y * U_DEPTH };
  const C = { x: S.x + L.x * U_R, y: S.y + L.y * U_R };
  const out = sampleLine(p0, S, U_DEPTH);
  const n = Math.round((Math.PI * U_R) / DS);
  for (let k = 1; k <= n; k++) {
    const f = (k / n) * Math.PI;
    out.push({ x: C.x + U_R * (-L.x * Math.cos(f) + h.x * Math.sin(f)), y: C.y + U_R * (-L.y * Math.cos(f) + h.y * Math.sin(f)) });
  }
  const E = { x: C.x + L.x * U_R, y: C.y + L.y * U_R };
  const back = sampleLine(E, { x: E.x - h.x * U_DEPTH, y: E.y - h.y * U_DEPTH }, U_DEPTH);
  return [...out, ...back.slice(1)];
}

export function buildPath(dir: Dir, lane: number, man: Maneuver): Path {
  const ctrl = connectorControls(dir, lane, man);
  const spawn = spawnPoint(dir, lane);
  const conn = man === 'U' ? sampleUturn(dir, lane) : sampleBezier(ctrl);
  const h1 = headingAfter(dir, man);
  const xLane = exitLaneFor(man, lane);
  const end = { x: ctrl[3].x + h1.x * EXIT_LEN, y: ctrl[3].y + h1.y * EXIT_LEN };
  const app = sampleLine(spawn, ctrl[0], APPROACH);
  const ext = sampleLine(ctrl[3], end, EXIT_LEN);
  const pts = [...app, ...conn.slice(1), ...ext.slice(1)];
  const n = pts.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), hs = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = pts[i].x; ys[i] = pts[i].y; }
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    hs[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  // кривизна → предел скорости → предвидение (обратный проход)
  const vc = new Float64Array(n);
  let vCurveMin = V_FREE;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
    let dh = hs[i1] - hs[i0];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const kappa = Math.abs(dh) / ((i1 - i0) * DS);
    vc[i] = kappa > 1e-6 ? Math.min(V_FREE, Math.sqrt(A_LAT / kappa)) : V_FREE;
    vCurveMin = Math.min(vCurveMin, vc[i]);
  }
  const vlim = new Float64Array(n);
  vlim[n - 1] = vc[n - 1];
  for (let i = n - 2; i >= 0; i--) vlim[i] = Math.min(vc[i], Math.sqrt(vlim[i + 1] ** 2 + 2 * B_CURVE * DS));
  let freeTime = 0;
  for (let i = 1; i < n; i++) freeTime += DS / Math.max(0.5, Math.min(vlim[i], vlim[i - 1]));
  const connStart = APPROACH, connEnd = APPROACH + (conn.length - 1) * DS;
  const id = `${dir}${lane}${man}`;
  const side = exitSide(h1);
  return {
    id, dir, lane, man, exitSide: side, exitLane: xLane,
    links: [approachLink(dir, lane), `C:${id}`, exitLink(side, xLane)],
    linkStart: [0, connStart, connEnd],
    connStart, connEnd, length: (n - 1) * DS,
    xs, ys, hs, vlim, vCurveMin, freeTime,
  };
}

export interface Pose { x: number; y: number; h: number }

/** Положение и направление в точке s (за концом пути — продолжение по прямой). */
export function poseAt(p: Path, s: number): Pose {
  const n = p.xs.length;
  if (s <= 0) {
    return { x: p.xs[0] + Math.cos(p.hs[0]) * s, y: p.ys[0] + Math.sin(p.hs[0]) * s, h: p.hs[0] };
  }
  const f = s / DS;
  if (f >= n - 1) {
    const e = s - (n - 1) * DS;
    return { x: p.xs[n - 1] + Math.cos(p.hs[n - 1]) * e, y: p.ys[n - 1] + Math.sin(p.hs[n - 1]) * e, h: p.hs[n - 1] };
  }
  const i = Math.floor(f), t = f - i;
  let dh = p.hs[i + 1] - p.hs[i];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return { x: p.xs[i] + (p.xs[i + 1] - p.xs[i]) * t, y: p.ys[i] + (p.ys[i + 1] - p.ys[i]) * t, h: p.hs[i] + dh * t };
}

export function vlimAt(p: Path, s: number): number {
  const i = Math.min(p.vlim.length - 1, Math.max(0, Math.round(s / DS)));
  return p.vlim[i];
}

/** Все возможные маршруты: для каждого въезда налево и разворот — с полосы 0, направо — с 1, прямо — с обеих. */
export function buildAllPaths(): Map<string, Path> {
  const m = new Map<string, Path>();
  for (const d of DIRS)
    for (const man of MANEUVERS)
      for (const lane of allLanesFor(man)) {
        const p = buildPath(d, lane, man);
        m.set(p.id, p);
      }
  return m;
}

/** Общий (кешированный) набор путей — геометрия не зависит от настроек. */
export const PATHS: Map<string, Path> = buildAllPaths();

export function pathId(dir: Dir, lane: number, man: Maneuver): string {
  return `${dir}${lane}${man}`;
}
