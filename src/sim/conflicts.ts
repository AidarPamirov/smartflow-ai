import { PATHS, poseAt, type Path, type Pose } from './routes';

/**
 * Геометрический анализ конфликтов между маршрутами.
 *
 * Для каждой пары маршрутов перебираются положения переднего бампера на соединителе
 * (и до выхода заднего бампера на полосу выезда). Кузов — прямоугольник 4,5 × 1,8 м,
 * повёрнутый по касательной к пути и расширенный на запас ZONE_MARGIN.
 * Зона конфликта пары — диапазон положений, при которых кузова могут пересечься.
 */
export const VEH_LEN = 4.5;
export const VEH_W = 1.8;
export const ZONE_MARGIN = 0.3;
const STEP = 0.5;

export type ConflictKind = 'cross' | 'merge' | 'diverge';

export interface Conflict {
  other: string;
  kind: ConflictKind;
  /** Диапазон положений переднего бампера ЭТОГО маршрута, в котором он занимает зону. */
  a: number;
  b: number;
  /** Тот же диапазон для другого маршрута. */
  oa: number;
  ob: number;
}

/** Углы прямоугольника кузова для положения переднего бампера s. */
export function bodyCorners(p: Path, s: number, len = VEH_LEN, w = VEH_W, margin = 0): [number, number][] {
  const c = poseAt(p, s - len / 2);
  return rectCorners(c, len + 2 * margin, w + 2 * margin);
}

export function rectCorners(c: Pose, len: number, w: number): [number, number][] {
  const ux = Math.cos(c.h), uy = Math.sin(c.h), vx = -uy, vy = ux;
  const hl = len / 2, hw = w / 2;
  return [
    [c.x + ux * hl + vx * hw, c.y + uy * hl + vy * hw],
    [c.x + ux * hl - vx * hw, c.y + uy * hl - vy * hw],
    [c.x - ux * hl - vx * hw, c.y - uy * hl - vy * hw],
    [c.x - ux * hl + vx * hw, c.y - uy * hl + vy * hw],
  ];
}

/** Теорема о разделяющей оси для двух выпуклых четырёхугольников. */
export function polysOverlap(A: [number, number][], B: [number, number][]): boolean {
  for (const P of [A, B])
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4];
      const nx = y1 - y2, ny = x2 - x1;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, y] of A) { const d = x * nx + y * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const [x, y] of B) { const d = x * nx + y * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA < minB || maxB < minA) return false;
    }
  return true;
}

function samplePositions(p: Path): number[] {
  const out: number[] = [];
  for (let s = p.connStart; s <= p.connEnd + VEH_LEN + 0.5; s += STEP) out.push(s);
  return out;
}

export function analyzePair(p: Path, q: Path): Conflict | null {
  const sp = samplePositions(p), sq = samplePositions(q);
  const cp = sp.map((s) => ({ s, c: poseAt(p, s - VEH_LEN / 2), r: bodyCorners(p, s, VEH_LEN, VEH_W, ZONE_MARGIN) }));
  const cq = sq.map((s) => ({ s, c: poseAt(q, s - VEH_LEN / 2), r: bodyCorners(q, s, VEH_LEN, VEH_W, ZONE_MARGIN) }));
  let a = Infinity, b = -Infinity, oa = Infinity, ob = -Infinity;
  const reach = VEH_LEN + 2 * ZONE_MARGIN + 0.5;
  for (const P of cp)
    for (const Q of cq) {
      if (Math.abs(P.c.x - Q.c.x) > reach || Math.abs(P.c.y - Q.c.y) > reach) continue;
      if (!polysOverlap(P.r, Q.r)) continue;
      if (P.s < a) a = P.s; if (P.s > b) b = P.s;
      if (Q.s < oa) oa = Q.s; if (Q.s > ob) ob = Q.s;
    }
  if (a === Infinity) return null;
  const kind: ConflictKind =
    p.dir === q.dir && p.lane === q.lane ? 'diverge' : p.links[2] === q.links[2] ? 'merge' : 'cross';
  return { other: q.id, kind, a: a - STEP, b: b + STEP, oa: oa - STEP, ob: ob + STEP };
}

export type ConflictTable = Map<string, Conflict[]>;

export function buildConflictTable(paths: Map<string, Path> = PATHS): ConflictTable {
  const t: ConflictTable = new Map();
  const ids = [...paths.keys()];
  for (const id of ids) t.set(id, []);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const p = paths.get(ids[i])!, q = paths.get(ids[j])!;
      const c = analyzePair(p, q);
      if (!c) continue;
      t.get(p.id)!.push(c);
      t.get(q.id)!.push({ other: p.id, kind: c.kind, a: c.oa, b: c.ob, oa: c.a, ob: c.b });
    }
  return t;
}

let cached: ConflictTable | null = null;
/** Таблица конфликтов вычисляется один раз (≈ сотни мс) и переиспользуется. */
export function conflictTable(): ConflictTable {
  if (!cached) cached = buildConflictTable();
  return cached;
}

/** Конфликтуют ли маршруты с точки зрения светофора (расхождение из одной полосы — не сигнальный конфликт). */
export function signalConflict(a: string, b: string, t: ConflictTable = conflictTable()): boolean {
  const c = t.get(a)?.find((x) => x.other === b);
  return !!c && c.kind !== 'diverge';
}
