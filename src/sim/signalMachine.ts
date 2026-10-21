/**
 * Конечный автомат светофора: зелёный → жёлтый → «все красные» → следующий зелёный.
 * Общий для лаборатории перекрёстка (src/sim/simulation.ts) и городских светофоров (src/signals/runtime.ts).
 *
 * Автомат не выбирает фазы сам: на зелёном он спрашивает решающую функцию, пора ли менять фазу и на какую.
 * Жёлтый и «все красные» нельзя пропустить или сократить: следующая фаза включается только через них.
 */
export const YELLOW = 3;
export const ALL_RED = 2;

export type SignalStage = 'green' | 'yellow' | 'allred';

export interface SignalState {
  /** Индекс текущей (или последней) зелёной фазы. */
  phase: number;
  /** Фаза, которая включится после «все красные». */
  next: number;
  stage: SignalStage;
  elapsed: number;
  /** Счётчик смен фазы (жёлтых). */
  cycle: number;
}

export const initialSignal = (phase = 0): SignalState => ({ phase, next: phase, stage: 'green', elapsed: 0, cycle: 0 });

/**
 * Шаг автомата на dt секунд.
 * @param decide вызывается только на зелёном: номер следующей фазы, если пора переключаться, иначе null.
 */
export function stepSignal(s: SignalState, dt: number, decide: (phase: number, elapsed: number) => number | null): void {
  s.elapsed += dt;
  if (s.stage === 'green') {
    const next = decide(s.phase, s.elapsed);
    if (next !== null) { s.next = next; s.stage = 'yellow'; s.elapsed = 0; s.cycle++; }
  } else if (s.stage === 'yellow') {
    if (s.elapsed >= YELLOW - 1e-9) { s.stage = 'allred'; s.elapsed = 0; }
  } else if (s.elapsed >= ALL_RED - 1e-9) {
    s.phase = s.next; s.stage = 'green'; s.elapsed = 0;
  }
}
