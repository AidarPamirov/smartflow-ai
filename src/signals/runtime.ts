/**
 * Работа одного городского светофора: режимы управления, защитные ограничения, журнал решений.
 *
 * Смену сигналов делает общий автомат src/sim/signalMachine.ts (тот же, что в лаборатории):
 * переход только через жёлтый 3 с и «все красные» 2 с, зелёный горит одной фазе.
 * Здесь — только решение «пора ли менять фазу и на какую»:
 *  - fixed — виртуальный фиксированный план (src/signals/plan.ts);
 *  - adaptive — адаптивный контроллер лаборатории (src/sim/controllers.ts, правила по очередям и ожиданию,
 *    без машинного обучения) на синтетических очередях демо-трафика;
 *  - manual — фаза держится до команды оператора.
 * Во всех режимах: минимальный зелёный MIN_GREEN_SAFE, жёсткий максимум HARD_MAX_GREEN (никто не ждёт бесконечно).
 * Если адаптивный контроллер ошибся (исключение, неверные данные), светофор переходит на фиксированный план
 * и записывает причину в журнал.
 */
import { makeController, type Controller, type PhaseObs } from '../sim/controllers';
import { ALL_RED, YELLOW, stepSignal, type SignalState } from '../sim/signalMachine';
import { fixedStateAt, type FixedTiming, type PhaseGroup } from './plan';

export type ControlMode = 'fixed' | 'adaptive' | 'manual';
export type Light = 'G' | 'Y' | 'R' | 'off';
export type RuntimeStatus = 'working' | 'inactive';

export const MIN_GREEN_SAFE = 8;
export const HARD_MAX_GREEN = 120;
export const ADAPTIVE_SPEC = { kind: 'adaptive' as const, minGreen: MIN_GREEN_SAFE, maxGreen: 60, waitWeight: 10 };
export const LOG_SIZE = 30;

export interface Decision {
  /** Время модели, с. */
  t: number;
  from: number;
  to: number;
  mode: ControlMode;
  reason: string;
}

export class SignalRuntime {
  state: SignalState;
  mode: ControlMode = 'fixed';
  status: RuntimeStatus = 'working';
  /** Фаза, которую попросил оператор (ручной режим). */
  manualTarget: number | null = null;
  readonly log: Decision[] = [];
  private adaptive: Controller = makeController(ADAPTIVE_SPEC);
  private t = 0;
  /** Когда фаза последний раз была зелёной (время модели). */
  private lastGreen: number[];

  constructor(readonly groups: PhaseGroup[], readonly timing: FixedTiming, t0 = 0) {
    if (!groups.length || timing.greens.length !== groups.length) throw new Error('план светофора пуст или не совпадает с фазами');
    const p = fixedStateAt(timing, t0);
    this.state = { phase: p.phase, next: p.next, stage: p.stage, elapsed: p.elapsed, cycle: 0 };
    this.t = t0;
    this.lastGreen = groups.map(() => t0);
  }

  /** Сколько секунд фаза k не получала зелёный. */
  sinceGreen(k: number): number {
    return this.state.stage === 'green' && this.state.phase === k ? 0 : this.t - this.lastGreen[k];
  }

  get n() { return this.groups.length; }

  setMode(mode: ControlMode) {
    if (mode === this.mode) return;
    this.note(this.state.phase, this.state.phase, `режим: ${this.mode} → ${mode}`);
    this.mode = mode;
    this.manualTarget = null;
  }

  /** Включить/выключить светофор (выключенный — перекрёсток без регулирования, сигналы не горят). */
  setStatus(status: RuntimeStatus) {
    if (status === this.status) return;
    this.note(this.state.phase, this.state.phase, status === 'inactive' ? 'светофор выключен оператором' : 'светофор включён');
    this.status = status;
  }

  /** Ручной режим: попросить фазу k. Переход всё равно идёт через жёлтый и «все красные». */
  requestPhase(k: number) {
    if (!(k >= 0 && k < this.n)) throw new Error(`нет фазы ${k}`);
    this.manualTarget = k;
  }

  private note(from: number, to: number, reason: string) {
    this.log.push({ t: Math.round(this.t * 10) / 10, from, to, mode: this.mode, reason });
    if (this.log.length > LOG_SIZE) this.log.splice(0, this.log.length - LOG_SIZE);
  }

  /**
   * Шаг на dt секунд модели.
   * @param observe наблюдения по фазам (нужны только адаптивному режиму); вызывается лениво.
   */
  step(dt: number, observe?: () => PhaseObs[]) {
    this.t += dt;
    if (this.status !== 'working') return;
    if (this.state.stage === 'green') this.lastGreen[this.state.phase] = this.t;
    stepSignal(this.state, dt, (phase, elapsed) => {
      const d = this.decide(phase, elapsed, observe);
      if (d) this.note(phase, d.next, d.reason);
      return d ? d.next : null;
    });
  }

  private decide(phase: number, elapsed: number, observe?: () => PhaseObs[]): { next: number; reason: string } | null {
    const n = this.n;
    if (n < 2) return null; // одна фаза — горит постоянно (не бывает для объектов со статусом ok)
    if (elapsed < MIN_GREEN_SAFE - 1e-9) return null;
    if (elapsed >= HARD_MAX_GREEN - 1e-9) return { next: (phase + 1) % n, reason: `жёсткий максимум зелёного ${HARD_MAX_GREEN} с` };
    if (this.mode === 'fixed') {
      return elapsed >= this.timing.greens[phase] - 1e-9 ? { next: (phase + 1) % n, reason: `фиксированный план: зелёный ${this.timing.greens[phase]} с` } : null;
    }
    if (this.mode === 'manual') {
      const k = this.manualTarget;
      return k !== null && k !== phase ? { next: k, reason: 'команда оператора' } : null;
    }
    // адаптивный
    try {
      if (!observe) throw new Error('нет данных об очередях');
      const obs = observe();
      if (obs.length !== n || obs.some((o) => !(o.queue >= 0 && o.approaching >= 0 && o.maxWait >= 0))) throw new Error('неверные данные об очередях');
      if (!this.adaptive.shouldEndGreen(phase, elapsed, obs, [])) return null;
      const next = this.adaptive.nextPhase(phase, obs, []);
      if (!(next >= 0 && next < n) || next === phase) throw new Error(`контроллер выбрал недопустимую фазу ${next}`);
      const cur = obs[phase];
      const reason = elapsed >= ADAPTIVE_SPEC.maxGreen - 1e-9
        ? `максимум зелёного ${ADAPTIVE_SPEC.maxGreen} с, ждёт фаза ${next + 1} (очередь ${obs[next].queue})`
        : cur.approaching === 0
          ? `разрыв потока: к стоп-линии фазы ${phase + 1} никто не подъезжает; ждёт фаза ${next + 1} (очередь ${obs[next].queue})`
          : `давление фазы ${next + 1} (очередь ${obs[next].queue}, ожидание ${Math.round(obs[next].maxWait)} с) более чем вдвое выше текущей`;
      return { next, reason };
    } catch (e) {
      this.mode = 'fixed';
      this.note(phase, phase, `ошибка адаптивного контроллера (${(e as Error).message}) → фиксированный план`);
      return elapsed >= this.timing.greens[phase] - 1e-9 ? { next: (phase + 1) % n, reason: 'фиксированный план (после ошибки адаптивного)' } : null;
    }
  }

  /** Сигнал для фазы-группы k. */
  light(k: number): Light {
    if (this.status !== 'working') return 'off';
    const s = this.state;
    if (s.stage === 'allred' || k !== s.phase) return 'R';
    return s.stage === 'green' ? 'G' : 'Y';
  }

  /** Сколько секунд до ближайшего переключения; null — зависит от очередей или оператора. */
  timeToSwitch(): number | null {
    const s = this.state;
    if (this.status !== 'working') return null;
    if (s.stage === 'yellow') return Math.max(0, YELLOW - s.elapsed);
    if (s.stage === 'allred') return Math.max(0, ALL_RED - s.elapsed);
    if (this.mode === 'fixed') return Math.max(0, Math.min(this.timing.greens[s.phase], HARD_MAX_GREEN) - s.elapsed);
    return null;
  }

  /** Сколько ещё зелёный гарантированно не сменится (минимальный зелёный). */
  minGreenLeft(): number {
    const s = this.state;
    return s.stage === 'green' ? Math.max(0, MIN_GREEN_SAFE - s.elapsed) : 0;
  }
}
