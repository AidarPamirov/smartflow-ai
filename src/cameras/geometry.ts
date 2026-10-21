/**
 * Геометрия виртуальных камер: пересечение линии траекторией, время пересечения, скорость на участке.
 * Только чистые функции в метрах (локальная проекция): их используют камеры городского слоя и тесты.
 *
 * Принципы:
 *  - событие «пересечение линии» — это пересечение ОТРЕЗКА траектории (положение до → после) с линией,
 *    заданной в тех же координатах, что и дорога; произвольная линия «на экране» не используется;
 *  - направление пересечения — по знаку векторного произведения относительно направления линии;
 *  - скорость — по времени между двумя линиями с известным расстоянием (участковый метод), а не по размеру
 *    машины в кадре; время пересечения каждой линии интерполируется внутри шага.
 */

export type XY = readonly [number, number];

/** Пересечение отрезков p0→p1 и q0→q1: параметры t (на p) и u (на q) в [0, 1] или null. */
export function segmentIntersection(p0: XY, p1: XY, q0: XY, q1: XY): { t: number; u: number } | null {
  const rx = p1[0] - p0[0], ry = p1[1] - p0[1];
  const sx = q1[0] - q0[0], sy = q1[1] - q0[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null; // параллельны (касание вдоль линии пересечением не считается)
  const qpx = q0[0] - p0[0], qpy = q0[1] - p0[1];
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** С какой стороны линии a→b лежит точка: +1 — слева, −1 — справа, 0 — на линии. */
export function sideOf(a: XY, b: XY, p: XY): number {
  const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return c > 1e-9 ? 1 : c < -1e-9 ? -1 : 0;
}

export interface LineCrossing {
  /** Доля шага (0…1), на которой произошло пересечение. */
  t: number;
  /** Номер отрезка линии. */
  seg: number;
  /** Направление относительно линии: слева направо или справа налево (по ходу задания линии). */
  dir: 'left_to_right' | 'right_to_left';
}

/** Первое пересечение шага траектории prev→cur с ломаной линией. */
export function crossPolyline(prev: XY, cur: XY, line: readonly XY[]): LineCrossing | null {
  let best: LineCrossing | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const hit = segmentIntersection(prev, cur, line[i], line[i + 1]);
    if (!hit) continue;
    const before = sideOf(line[i], line[i + 1], prev);
    const after = sideOf(line[i], line[i + 1], cur);
    if (after === 0 || before === after) continue; // доехал до линии или коснулся без перехода на другую сторону
    const dir = before > 0 || after < 0 ? 'left_to_right' : 'right_to_left';
    if (!best || hit.t < best.t) best = { t: hit.t, seg: i, dir };
  }
  return best;
}

/** Момент, когда координата вдоль пути прошла отметку mark за шаг [t0, t1]; null — не прошла. */
export function crossingTime(pos0: number, pos1: number, mark: number, t0: number, t1: number): number | null {
  if (!(pos0 < mark && pos1 >= mark)) return null;
  const f = (mark - pos0) / (pos1 - pos0);
  return t0 + f * (t1 - t0);
}

/** Скорость на участке известной длины, м/с; null — время не определено. */
export function sectionSpeed(distance: number, tEnter: number, tExit: number): number | null {
  const dt = tExit - tEnter;
  if (!(distance > 0) || !(dt > 1e-6)) return null;
  return distance / dt;
}

/** Перцентиль p (0…1) по линейной интерполяции; null для пустого массива. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const k = (a.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(k), hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}
