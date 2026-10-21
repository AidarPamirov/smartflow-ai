/**
 * Результаты эксперимента «коридор» (smartflow-sumo-corridor/1), пишет sumo/smartflow_sumo/corridor.py.
 * Только типы, проверка и вычисления для отображения — без отрисовки.
 */
import type { Stat } from './trace';
import { TraceError } from './trace';

export const CORRIDOR_FORMAT = 'smartflow-sumo-corridor/1';
export type CorridorCtrl = 'fixed' | 'coordinated' | 'adaptive';

export interface CorridorRow {
  load: string;
  controller: CorridorCtrl;
  runs: number;
  seeds: number[];
  mean_wait: Stat; mean_time_loss: Stat; p95_travel_time: Stat; total_time_loss_veh_h: Stat; mean_stops: Stat; throughput_veh_h: Stat;
  through_time_eb: Stat; through_time_wb: Stat; through_stops_eb: Stat; through_stops_wb: Stat;
  completed: Stat; unfinished: Stat; demand_vehicles: Stat;
  queue_by_node: Record<string, Stat>;
  spill_seconds: Record<string, Stat>;
  max_fill: Record<string, Stat>;
  collisions: number; teleports: number; conflict_steps: number; safety_overrides: number; fallbacks: number;
  /** Продление «все красные», пока в зоне перекрёстка стоит машина, с (сумма по узлам). */
  clearance_hold_s?: Stat;
  collision_details?: { t: number; type: string; lane: string }[];
  decision_reasons: Record<string, number>;
}

export interface CorridorResults {
  format: string;
  corridor: { id: string; title: string; nodes: { id: string; title: string; x: number; osm_site: string }[]; spacing_m: number[]; assumptions: string[]; source: string };
  sumo_version: string;
  generated: string;
  params: {
    loads_veh_h: Record<string, Record<string, number>>; seeds: number[]; duration_s: number; warmup_s: number;
    wave_speed_kmh: number; spill_zone_m: number;
    incident: { title: string; flows_veh_h: Record<string, number>; duration_s: number; teleport_s?: number; closures: { edge: string; from_s: number; to_s: number }[] } | null;
    fixed: { node: string; greens: number[]; cycle: number; phases: string[]; offset: number }[];
    coordinated: { node: string; greens: number[]; cycle: number; phases: string[]; offset: number; east_phase: number }[];
  };
  summary: CorridorRow[];
  elapsed_s: number;
}

export function parseCorridor(d: unknown): CorridorResults {
  const r = d as Partial<CorridorResults>;
  if (!r || r.format !== CORRIDOR_FORMAT) throw new TraceError(`format должен быть ${CORRIDOR_FORMAT}`);
  if (!r.corridor?.nodes?.length || !Array.isArray(r.summary) || !r.summary.length || !r.params) throw new TraceError('в результатах коридора нет данных');
  for (const row of r.summary)
    if (!['fixed', 'coordinated', 'adaptive'].includes(row.controller)) throw new TraceError(`неизвестный контроллер ${row.controller}`);
  return r as CorridorResults;
}

/** Лучший контроллер по метрике на нагрузке (меньше — лучше); null — нет данных. Ничья (< 1 %) — несколько. */
export function best(rows: CorridorRow[], load: string, get: (r: CorridorRow) => Stat): CorridorCtrl[] {
  const xs = rows.filter((r) => r.load === load).map((r) => ({ c: r.controller, v: get(r)[0] })).filter((x) => x.v !== null) as { c: CorridorCtrl; v: number }[];
  if (!xs.length) return [];
  const m = Math.min(...xs.map((x) => x.v));
  return xs.filter((x) => x.v <= m * 1.01).map((x) => x.c);
}

/** Наибольшее среднее по seed заполнение участка между перекрёстками (0…1). */
export const maxFill = (r: CorridorRow) => Math.max(...Object.values(r.max_fill).map((s) => s[0] ?? 0));
export const spillTotal = (r: CorridorRow) => Object.values(r.spill_seconds).reduce((a, s) => a + (s[0] ?? 0), 0);
