import type { ControllerSpec } from './controllers';
import { MANEUVERS, type Maneuver } from './geometry';
import type { Summary } from './metrics';
import type { LaneUse } from './geometry';
import type { LeftMode, UturnAllowed } from './phases';
import { Simulation, validateFlows, validateTurns, type Flows, type Turns } from './simulation';

/** Условия эксперимента — общие для всех сравниваемых контроллеров. */
export interface Scenario {
  flows: Flows;
  turns?: Turns;
  uturn?: UturnAllowed;
  leftMode?: LeftMode;
  laneUse?: LaneUse;
}

export interface ExperimentConfig extends Scenario {
  duration: number; // с
  seeds: number[];
  specs: ControllerSpec[];
}

export interface ExperimentRun {
  seed: number;
  kind: ControllerSpec['kind'];
  summary: Summary;
  generated: number;
}

export function validateExperiment(c: ExperimentConfig): string | null {
  const f = validateFlows(c.flows);
  if (f) return f;
  if (c.turns) { const t = validateTurns(c.turns); if (t) return t; }
  if (!(c.duration >= 120 && c.duration <= 7200)) return 'Длительность эксперимента: от 120 до 7200 с';
  if (c.seeds.length < 1 || c.seeds.length > 20) return 'Число повторов: от 1 до 20';
  if (Object.values(c.flows).every((v) => v === 0)) return 'Все потоки равны нулю — сравнивать нечего';
  return null;
}

/** Один прогон без отрисовки. Детерминирован: (сценарий, seed, spec) → тот же результат. */
export function runOnce(sc: Scenario, seed: number, spec: ControllerSpec, duration: number, diagnostics = true): ExperimentRun {
  const sim = new Simulation({
    seed, flows: { ...sc.flows }, controller: spec,
    turns: sc.turns ? JSON.parse(JSON.stringify(sc.turns)) : undefined,
    uturn: sc.uturn ? { ...sc.uturn } : undefined, leftMode: sc.leftMode, laneUse: sc.laneUse, diagnostics,
  });
  sim.run(duration);
  return { seed, kind: spec.kind, summary: sim.summary(), generated: sim.generated };
}

/**
 * Прогоняет каждый контроллер на одних и тех же seed. Прибытия и выбор манёвров генерируются
 * независимыми потоками ГПСЧ, поэтому спрос в паре прогонов идентичен.
 * Асинхронный, отдаёт управление UI между прогонами.
 */
export async function runExperiment(
  c: ExperimentConfig,
  onProgress?: (done: number, total: number) => void,
  signal?: { cancelled: boolean },
): Promise<ExperimentRun[]> {
  const err = validateExperiment(c);
  if (err) throw new Error(err);
  const out: ExperimentRun[] = [];
  const total = c.seeds.length * c.specs.length;
  for (const seed of c.seeds)
    for (const spec of c.specs) {
      if (signal?.cancelled) return out;
      out.push(runOnce(c, seed, spec, c.duration));
      onProgress?.(out.length, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  return out;
}

export interface Aggregate {
  kind: ControllerSpec['kind'];
  n: number;
  avgWait: number | null;
  avgDelay: number | null;
  maxQueue: number;
  throughput: number | null;
  served: number;
  waitBy: Record<Maneuver, number | null>;
  zoneViolations: number;
  overlaps: number;
  redViolations: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function aggregate(runs: ExperimentRun[], kind: ControllerSpec['kind']): Aggregate | null {
  const rs = runs.filter((r) => r.kind === kind);
  if (!rs.length) return null;
  const nums = (f: (s: Summary) => number | null) => rs.map((r) => f(r.summary)).filter((x): x is number => x !== null);
  const waitBy = {} as Record<Maneuver, number | null>;
  for (const m of MANEUVERS) waitBy[m] = mean(nums((s) => s.byManeuver[m].avgWait));
  return {
    kind,
    n: rs.length,
    avgWait: mean(nums((s) => s.avgWait)),
    avgDelay: mean(nums((s) => s.avgDelay)),
    maxQueue: mean(rs.map((r) => r.summary.maxQueue)) ?? 0,
    throughput: mean(nums((s) => s.throughput)),
    served: mean(rs.map((r) => r.summary.served)) ?? 0,
    waitBy,
    zoneViolations: rs.reduce((a, r) => a + r.summary.safety.zoneViolations, 0),
    overlaps: rs.reduce((a, r) => a + r.summary.safety.overlaps, 0),
    redViolations: rs.reduce((a, r) => a + r.summary.safety.redViolations, 0),
  };
}
