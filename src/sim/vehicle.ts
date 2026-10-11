import type { Dir, Maneuver } from './geometry';
import type { Path } from './routes';

/**
 * Параметры модели следования Intelligent Driver Model (Treiber et al., 2000).
 * Значения типичны для городского легкового автомобиля.
 */
export const IDM = {
  v0: 13.9, // желаемая скорость, м/с (50 км/ч)
  T: 1.4, // желаемый временной интервал, с
  s0: 2.0, // минимальный зазор в пробке, м
  a: 1.5, // комфортное ускорение, м/с²
  b: 2.5, // комфортное замедление, м/с²
  delta: 4,
  bMax: 8.0, // физический предел торможения, м/с²
} as const;

/** Замедление, при котором водитель на жёлтом ещё решает остановиться. */
export const B_YELLOW_DECIDE = 4.0;
/** Порог скорости, ниже которого автомобиль считается стоящим (для ожидания и очередей). */
export const STOP_SPEED = 0.5;
export const VEHICLE_LEN = 4.5;

export interface Vehicle {
  id: number;
  dir: Dir;
  lane: number;
  man: Maneuver;
  path: Path;
  /** Позиция переднего бампера вдоль пути маршрута, м. */
  s: number;
  v: number;
  a: number;
  len: number;
  /** Время появления спроса (прибытия), с — включает ожидание за пределами модели. */
  arriveT: number;
  /** Накопленное время ожидания (скорость < STOP_SPEED), с. */
  wait: number;
  /** Номер жёлтой фазы, на которой водитель решил проехать (не может остановиться). */
  goOnYellow: number;
  /** Передний бампер пересёк стоп-линию. */
  crossed: boolean;
  /** Получен допуск на въезд: машина держит все конфликтные зоны своего пути. */
  committed: boolean;
  /** Защищённая машина хотя бы раз ждала уступающую (для статистики). */
  blockedByYield: boolean;
}

/** Ускорение IDM. gap — чистый зазор до препятствия, dv = v - vЛидера, v0 — желаемая скорость в этой точке. */
export function idmAccel(v: number, gap: number, dv: number, v0: number = IDM.v0): number {
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), IDM.delta);
  if (!Number.isFinite(gap)) return Math.max(IDM.a * free, -IDM.bMax);
  const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
  const g = Math.max(gap, 0.01);
  const acc = IDM.a * (free - (sStar / g) * (sStar / g));
  return Math.max(acc, -IDM.bMax);
}
