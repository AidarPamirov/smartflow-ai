import type { Phase } from './phases';

/** Наблюдение контроллера по одной фазе (все маршруты, которые она открывает). */
export interface PhaseObs {
  /** Стоящие перед стоп-линией + ожидающие въезда в модель. */
  queue: number;
  /** Автомобили в зоне детектора (≤ DETECTOR_ZONE м до стоп-линии), любая скорость. */
  approaching: number;
  /** Максимальное текущее ожидание среди ещё не проехавших, с. */
  maxWait: number;
}

export const DETECTOR_ZONE = 40;
export const YELLOW = 3;
export const ALL_RED = 2;

export interface FixedSpec {
  kind: 'fixed';
  greenNS: number;
  greenEW: number;
  /** Длительность защищённой левой фазы (режим «защищённый левый»). */
  greenLeft: number;
}
export interface AdaptiveSpec {
  kind: 'adaptive';
  minGreen: number;
  maxGreen: number;
  /** Сколько секунд ожидания эквивалентны одному автомобилю в очереди. */
  waitWeight: number;
}
export type ControllerSpec = FixedSpec | AdaptiveSpec;

export interface Controller {
  readonly spec: ControllerSpec;
  /** Вызывается каждый шаг на зелёной фазе: пора ли заканчивать зелёный. */
  shouldEndGreen(cur: number, elapsed: number, obs: PhaseObs[], phases: Phase[]): boolean;
  /** Какую фазу включить следующей. */
  nextPhase(cur: number, obs: PhaseObs[], phases: Phase[]): number;
}

export const DEFAULT_FIXED: FixedSpec = { kind: 'fixed', greenNS: 30, greenEW: 30, greenLeft: 12 };
export const DEFAULT_ADAPTIVE: AdaptiveSpec = { kind: 'adaptive', minGreen: 8, maxGreen: 60, waitWeight: 10 };

const hasDemand = (o: PhaseObs) => o.queue > 0 || o.approaching > 0;

class FixedController implements Controller {
  constructor(readonly spec: FixedSpec) {}
  green(ph: Phase): number {
    if (ph.kind === 'left') return this.spec.greenLeft;
    return ph.axis === 'NS' ? this.spec.greenNS : this.spec.greenEW;
  }
  shouldEndGreen(cur: number, elapsed: number, _obs: PhaseObs[], phases: Phase[]): boolean {
    return elapsed >= this.green(phases[cur]);
  }
  nextPhase(cur: number, _obs: PhaseObs[], phases: Phase[]): number {
    return (cur + 1) % phases.length;
  }
}

/**
 * Адаптивный (актуированный) контроллер на правилах — без машинного обучения.
 * Зелёный завершается после минимального зелёного, если в других фазах есть спрос и:
 *  — достигнут максимальный зелёный; или
 *  — «разрыв потока»: в зоне детектора текущей фазы нет машин; или
 *  — давление другой фазы более чем вдвое выше текущей (давление = очередь + maxWait / waitWeight).
 * Следующей включается ближайшая по циклу фаза со спросом (пустые фазы пропускаются).
 */
class AdaptiveController implements Controller {
  constructor(readonly spec: AdaptiveSpec) {}
  pressure(o: PhaseObs): number {
    return o.queue + o.maxWait / this.spec.waitWeight;
  }
  shouldEndGreen(cur: number, elapsed: number, obs: PhaseObs[]): boolean {
    if (elapsed < this.spec.minGreen) return false;
    const others = obs.filter((o, i) => i !== cur && hasDemand(o));
    if (others.length === 0) return false;
    if (elapsed >= this.spec.maxGreen) return true;
    const c = obs[cur];
    if (c.approaching === 0) return true;
    const curP = Math.max(c.approaching, c.queue) + c.maxWait / this.spec.waitWeight;
    return Math.max(...others.map((o) => this.pressure(o))) > 2 * curP;
  }
  nextPhase(cur: number, obs: PhaseObs[]): number {
    for (let k = 1; k < obs.length; k++) {
      const i = (cur + k) % obs.length;
      if (hasDemand(obs[i])) return i;
    }
    return (cur + 1) % obs.length;
  }
}

export function validateSpec(spec: ControllerSpec): string | null {
  if (spec.kind === 'fixed') {
    for (const g of [spec.greenNS, spec.greenEW, spec.greenLeft])
      if (!(g >= 5 && g <= 120)) return 'Длительность зелёного должна быть от 5 до 120 с';
  } else {
    if (!(spec.minGreen >= 5 && spec.minGreen <= 60)) return 'Минимальный зелёный: 5–60 с';
    if (!(spec.maxGreen >= spec.minGreen && spec.maxGreen <= 180))
      return 'Максимальный зелёный должен быть ≥ минимального и ≤ 180 с';
    if (!(spec.waitWeight > 0)) return 'Вес ожидания должен быть > 0';
  }
  return null;
}

export function makeController(spec: ControllerSpec): Controller {
  const err = validateSpec(spec);
  if (err) throw new Error(err);
  return spec.kind === 'fixed' ? new FixedController(spec) : new AdaptiveController(spec);
}

export const CONTROLLER_LABEL: Record<ControllerSpec['kind'], string> = {
  fixed: 'Фиксированный цикл',
  adaptive: 'Адаптивный (очереди + ожидание)',
};
