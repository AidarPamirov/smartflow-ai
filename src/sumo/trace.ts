/**
 * Формат данных SUMO → веб (smartflow-sumo-trace/1 и smartflow-sumo-results/1).
 * Пишет Python (sumo/smartflow_sumo/trace.py, experiment.py), читает эта страница.
 * Проверка повторяет validate_trace из Python, чтобы обе стороны понимали формат одинаково.
 */

export const TRACE_FORMAT = 'smartflow-sumo-trace/1';
export const RESULTS_FORMAT = 'smartflow-sumo-results/1';

export interface TraceLane { id: string; shape: number[]; width: number }
export interface TraceLink { index: number; movement: string; in_lane: string; x: number; y: number }
export interface TraceFrame {
  t: number;
  /** Строка состояния светофора SUMO, символ на связь: G/g — зелёный, y — жёлтый, r — красный. */
  signal: string;
  phase: number;
  stage: 'green' | 'yellow' | 'allred';
  /** [id, x, y, angle, speed] × N; angle — градусы от севера по часовой, speed — м/с. */
  v: number[];
}
export interface Trace {
  format: string;
  meta: {
    scenario: string; title: string; controller: 'fixed' | 'adaptive'; load: string; seed: number; plan: string;
    sumo_version: string; sample_s: number; window: [number, number]; center: { lat: number; lon: number };
    generated: string; approximation_note: string;
  };
  geometry: { bounds: [number, number, number, number]; lanes: TraceLane[]; junction: number[]; links: TraceLink[] };
  phases: { name: string; movements: string[] }[];
  frames: TraceFrame[];
  summary: Record<string, unknown>;
}

export class TraceError extends Error {}

export function validateTrace(d: unknown): string[] {
  const e: string[] = [];
  const t = d as Partial<Trace>;
  if (!t || typeof t !== 'object' || t.format !== TRACE_FORMAT) return [`format должен быть ${TRACE_FORMAT}`];
  const m = (t.meta ?? {}) as Partial<Trace['meta']>;
  for (const k of ['scenario', 'controller', 'load', 'seed', 'sample_s', 'window', 'sumo_version', 'approximation_note'] as const)
    if (!(k in m)) e.push(`meta.${k} отсутствует`);
  if (m.controller !== 'fixed' && m.controller !== 'adaptive') e.push('meta.controller: fixed или adaptive');
  const g = t.geometry;
  const lanes = g?.lanes ?? [];
  if (!lanes.length) e.push('geometry.lanes пуст');
  for (const l of lanes) if (!Array.isArray(l.shape) || l.shape.length < 4 || l.shape.length % 2) e.push(`полоса ${l.id}: неверная форма`);
  const links = g?.links ?? [];
  if (links.some((l, i) => l.index !== i)) e.push('geometry.links: индексы должны идти подряд с 0');
  const phases = t.phases ?? [];
  if (!phases.length) e.push('phases пуст');
  const frames = t.frames ?? [];
  if (!frames.length) e.push('frames пуст');
  let prev: number | null = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (typeof f.signal !== 'string' || f.signal.length !== links.length || /[^GgyrRuoO]/.test(f.signal)) { e.push(`кадр ${i}: строка сигнала не соответствует связям`); break; }
    if (!['green', 'yellow', 'allred'].includes(f.stage)) { e.push(`кадр ${i}: неизвестная стадия`); break; }
    if (!(f.phase >= 0 && f.phase < phases.length)) { e.push(`кадр ${i}: неверная фаза`); break; }
    if (!Array.isArray(f.v) || f.v.length % 5) { e.push(`кадр ${i}: v должно содержать по 5 чисел на машину`); break; }
    if (prev !== null && f.t <= prev) { e.push(`кадр ${i}: время не возрастает`); break; }
    prev = f.t;
  }
  return e;
}

export function parseTrace(d: unknown): Trace {
  const errs = validateTrace(d);
  if (errs.length) throw new TraceError(errs.slice(0, 3).join('; '));
  return d as Trace;
}

/** [среднее, ст. отклонение] по повторам; null — нет данных. */
export type Stat = [number | null, number | null];

export interface ResultRow {
  load: string; controller: 'fixed' | 'adaptive'; runs: number; seeds: number[];
  mean_wait: Stat; mean_time_loss: Stat; mean_queue: Stat; max_queue_approach: Stat;
  completed: Stat; unfinished: Stat; demand_vehicles: Stat;
  collisions: number; teleports: number; conflict_steps: number;
  min_green_seen: number; min_yellow_seen: number; min_allred_seen: number;
}

export interface Results {
  format: string;
  scenario: { id: string; title: string; assumptions: string[]; osm_facts: string[] };
  sumo_version: string;
  generated: string;
  params: {
    loads_veh_h: Record<string, Record<string, number>>; turn_shares: Record<string, number>; seeds: number[];
    duration_s: number; warmup_s: number; step_s: number;
    timing: { min_green: number; yellow: number; all_red: number; hard_max_green: number };
    fixed: { design_load: string; cycle_s: number; greens_s: number[]; phases: string[] };
    adaptive: Record<string, unknown>;
  };
  summary: ResultRow[];
  elapsed_s: number;
}

export function parseResults(d: unknown): Results {
  const r = d as Partial<Results>;
  if (!r || r.format !== RESULTS_FORMAT) throw new TraceError(`format должен быть ${RESULTS_FORMAT}`);
  if (!Array.isArray(r.summary) || !r.summary.length) throw new TraceError('в результатах нет сводки');
  if (!r.params || !r.scenario) throw new TraceError('в результатах нет параметров эксперимента');
  return r as Results;
}

/** Положения машин в момент t: линейная интерполяция между соседними кадрами (кадры SUMO идут через sample_s). */
export function vehiclesAt(tr: Trace, t: number): { id: number; x: number; y: number; angle: number; speed: number }[] {
  const fr = tr.frames;
  if (!fr.length) return [];
  const t0 = fr[0].t, dt = tr.meta.sample_s;
  const k = Math.max(0, Math.min(fr.length - 1, Math.floor((t - t0) / dt)));
  const a = fr[k], b = fr[Math.min(fr.length - 1, k + 1)];
  const u = b === a ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const next = new Map<number, number>();
  for (let i = 0; i < b.v.length; i += 5) next.set(b.v[i], i);
  const out = [];
  for (let i = 0; i < a.v.length; i += 5) {
    const id = a.v[i];
    let x = a.v[i + 1], y = a.v[i + 2], angle = a.v[i + 3];
    const j = next.get(id);
    if (j !== undefined && u > 0) {
      x += (b.v[j + 1] - x) * u;
      y += (b.v[j + 2] - y) * u;
      let d = b.v[j + 3] - angle;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      angle += d * u;
    }
    out.push({ id, x, y, angle, speed: a.v[i + 4] });
  }
  return out;
}

export function frameAt(tr: Trace, t: number): TraceFrame {
  const fr = tr.frames;
  const k = Math.max(0, Math.min(fr.length - 1, Math.floor((t - fr[0].t) / tr.meta.sample_s)));
  return fr[k];
}
