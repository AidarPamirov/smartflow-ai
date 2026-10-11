/**
 * Геометрия перекрёстка. Единицы — метры. Центр перекрёстка в (0,0),
 * экранная система координат (ось Y вниз). Правостороннее движение.
 *
 * Стоп-линия отнесена от края пересекаемой дороги на SETBACK (радиус бордюра),
 * поэтому повороты получают реалистичный радиус: правый ≈ 7,75 м, левый ≈ 14,75 м.
 */
export type Dir = 'N' | 'E' | 'S' | 'W'; // откуда приезжает автомобиль (сторона въезда)
export type Axis = 'NS' | 'EW';
export type Maneuver = 'L' | 'T' | 'R' | 'U';
export interface Vec { x: number; y: number }

export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];
export const AXES: readonly Axis[] = ['NS', 'EW'];
export const MANEUVERS: readonly Maneuver[] = ['T', 'L', 'R', 'U'];
export const LANES_PER_APPROACH = 2;
export const LANE_W = 3.5;
/** Половина ширины дороги = ширина полос одного направления. */
export const HALF = LANES_PER_APPROACH * LANE_W;
/** Отступ стоп-линии от края пересекаемой проезжей части. */
export const SETBACK = 6;
/** Расстояние от центра до начала зоны перекрёстка (стоп-линии) по любой оси. */
export const ENTRY = HALF + SETBACK;
/** Длина въездного участка от точки появления до зоны перекрёстка. */
export const APPROACH = 120;
/** Длина выездного участка. */
export const EXIT_LEN = 120;
/** Предельное положение переднего бампера перед стоп-линией. */
export const STOP_S = APPROACH - 1.0;
/** Радиус скругления углов (для отрисовки). */
export const CURB_R = SETBACK;
/** Половина видимой области для отрисовки. */
export const VIEW = APPROACH + ENTRY;

export const DIR_LABEL: Record<Dir, string> = { N: 'Север', E: 'Восток', S: 'Юг', W: 'Запад' };
export const MANEUVER_LABEL: Record<Maneuver, string> = { T: 'Прямо', L: 'Налево', R: 'Направо', U: 'Разворот' };

export function axisOf(dir: Dir): Axis {
  return dir === 'N' || dir === 'S' ? 'NS' : 'EW';
}

/** Единичный вектор движения автомобиля, въезжающего с этой стороны. */
export function heading(dir: Dir): Vec {
  switch (dir) {
    case 'N': return { x: 0, y: 1 }; // с севера едет вниз
    case 'S': return { x: 0, y: -1 };
    case 'E': return { x: -1, y: 0 };
    case 'W': return { x: 1, y: 0 };
  }
}

/** Правая нормаль к направлению движения (экранные координаты). */
export function rightOf(h: Vec): Vec {
  return { x: -h.y, y: h.x };
}

/** Направление после манёвра. */
export function headingAfter(dir: Dir, m: Maneuver): Vec {
  const h = heading(dir);
  switch (m) {
    case 'T': return h;
    case 'R': return { x: -h.y, y: h.x };
    case 'L': return { x: h.y, y: -h.x };
    case 'U': return { x: -h.x, y: -h.y };
  }
}

/** Сторона, на которую уезжает автомобиль с направлением h. */
export function exitSide(h: Vec): Dir {
  if (h.y < -0.5) return 'N';
  if (h.y > 0.5) return 'S';
  return h.x > 0 ? 'E' : 'W';
}

/** Смещение центра полосы от осевой линии (полоса 0 — у осевой, 1 — крайняя правая). */
export function laneOffset(lane: number): number {
  return LANE_W / 2 + lane * LANE_W;
}

/**
 * Разметка полос въезда:
 *  'dedicated' — левая полоса только налево и разворот, правая — прямо и направо;
 *  'shared'    — левая: налево, разворот и прямо; правая: прямо и направо.
 */
export type LaneUse = 'dedicated' | 'shared';

/** Полосы въезда, с которых разрешён манёвр. */
export function lanesFor(m: Maneuver, use: LaneUse = 'dedicated'): number[] {
  switch (m) {
    case 'L': case 'U': return [0];
    case 'R': return [1];
    case 'T': return use === 'shared' ? [0, 1] : [1];
  }
}

/** Все физически возможные полосы манёвра (для построения путей). */
export function allLanesFor(m: Maneuver): number[] {
  return m === 'T' ? [0, 1] : lanesFor(m);
}

/** Полоса выезда для манёвра с данной полосы. */
export function exitLaneFor(m: Maneuver, lane: number): number {
  switch (m) {
    case 'T': return lane;
    case 'L': return 0;
    case 'R': case 'U': return 1;
  }
}

/** Точка появления автомобиля. */
export function spawnPoint(dir: Dir, lane: number): Vec {
  const h = heading(dir), r = rightOf(h), o = laneOffset(lane), D = ENTRY + APPROACH;
  return { x: -h.x * D + r.x * o, y: -h.y * D + r.y * o };
}

/** Точка, где въездная полоса входит в зону перекрёстка (у стоп-линии). */
export function entryPoint(dir: Dir, lane: number): Vec {
  const h = heading(dir), r = rightOf(h), o = laneOffset(lane);
  return { x: -h.x * ENTRY + r.x * o, y: -h.y * ENTRY + r.y * o };
}

/** Точка, где траектория выходит из зоны перекрёстка на полосу выезда. */
export function exitPoint(h: Vec, lane: number): Vec {
  const r = rightOf(h), o = laneOffset(lane);
  return { x: h.x * ENTRY + r.x * o, y: h.y * ENTRY + r.y * o };
}
