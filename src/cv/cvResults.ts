/**
 * Результаты проверки модулей компьютерного зрения (smartflow-cv-eval/1), пишет vision/smartflow_cv/evaluate.py.
 * Только типы и проверка формата. Пустые метрики — null («нет данных»), а не ноль.
 */
import { TraceError } from '../sumo/trace';

export const CV_FORMAT = 'smartflow-cv-eval/1';
export type Stat = [number | null, number | null];

export interface CvRow {
  condition: string; title: string; seeds: number[];
  detection_precision_pct: Stat; detection_recall_pct: Stat;
  detection_recall_isolated_pct: Stat; detection_recall_overlapping_pct: Stat; overlapping_share_pct: Stat;
  id_switches_per_vehicle: Stat;
  speed_coverage_pct: Stat; speed_mae_kmh: Stat; speed_p95_abs_err_kmh: Stat; speed_within_5kmh_pct: Stat;
  speeding_gt: number | null; speeding_true: number | null; speeding_false: number | null;
  solid_gt: number | null; solid_events: number | null; solid_true: number | null; solid_insufficient: number | null;
  count_gt: number | null; count_est: number | null;
  density_count_mae: Stat; queue_mae_m: Stat; ms_per_frame: Stat; missing_frames: number | null;
  module_status: Record<string, string>;
}

export interface CvModule { id: string; title: string; impl: string; verified: string | null; alt?: string }

export interface CvResults {
  format: string;
  generated: string;
  opencv: string;
  scene: {
    note: string; fps: number; duration_s: number; frame_px: [number, number]; camera_height_m: number;
    solid_line_x_m: [number, number]; stop_line_x_m: number; eval_zone_x_m: [number, number]; speed_limit_kmh: number; speed_tolerance_kmh: number;
  };
  modules: CvModule[];
  conditions: Record<string, string>;
  summary: CvRow[];
  images: { file: string; condition: string; t: number }[];
  elapsed_s: number;
}

const STATUSES = new Set(['off', 'ok', 'no_calibration', 'no_frame', 'unavailable', 'insufficient_data']);

export function validateCv(d: unknown): string[] {
  const r = d as Partial<CvResults>;
  const e: string[] = [];
  if (!r || r.format !== CV_FORMAT) return [`format должен быть ${CV_FORMAT}`];
  if (!Array.isArray(r.modules) || r.modules.length !== 6) e.push('должно быть 6 модулей');
  if (!Array.isArray(r.summary) || !r.summary.length) e.push('нет сводки');
  for (const row of r.summary ?? []) {
    for (const [k, v] of Object.entries(row)) {
      if (Array.isArray(v) && v.length === 2 && v.some((x) => x !== null && (typeof x !== 'number' || !Number.isFinite(x)))) e.push(`${row.condition}.${k}: не число`);
      if (k.endsWith('_pct') && Array.isArray(v) && v[0] !== null && ((v[0] as number) < 0 || (v[0] as number) > 100)) e.push(`${row.condition}.${k}: вне 0…100`);
    }
    for (const [m, s] of Object.entries(row.module_status ?? {})) if (!STATUSES.has(s)) e.push(`${row.condition}: статус ${m}=${s}`);
  }
  return e;
}

export function parseCv(d: unknown): CvResults {
  const errs = validateCv(d);
  if (errs.length) throw new TraceError(errs.slice(0, 3).join('; '));
  return d as CvResults;
}

export const STATUS_LABEL: Record<string, string> = {
  ok: 'работает', off: 'выключен', no_calibration: 'нет калибровки', no_frame: 'нет кадра', unavailable: 'модель не подключена',
  insufficient_data: 'недостаточно данных',
};

// ───────── проверка на реальном размеченном видео (UA-DETRAC), пишет vision/smartflow_cv/detrac_eval.py ─────────

export const CV_REAL_FORMAT = 'smartflow-cv-real/1';

export interface Prf { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }
export interface RealScore {
  iou05: Prf; iou03: Prf; merged_fp: number; count_gt: number; count_ours: number; count_error_pct: number | null; ms_per_frame: number | null;
  count_abs_error_pct_mean?: number | null;
}
export interface RealSequence {
  sequence: string; frames: number; size: [number, number]; gt_vehicles_per_frame: number; road_mask_share: number; mean_luminance: number;
  results: Record<string, RealScore>;
}
export interface CvReal {
  format: string;
  generated: string;
  dataset: { name: string; paper: string; copy: string; sequences: string[]; frames_per_sequence: number; fps: number; note: string };
  detectors: Record<string, string>;
  protocol: Record<string, unknown>;
  total: Record<string, RealScore>;
  sequences: RealSequence[];
}

export function parseCvReal(d: unknown): CvReal {
  const r = d as Partial<CvReal>;
  if (!r || r.format !== CV_REAL_FORMAT) throw new Error(`format должен быть ${CV_REAL_FORMAT}`);
  if (!r.total || !Array.isArray(r.sequences) || !r.sequences.length) throw new Error('в результатах нет данных');
  for (const [k, t] of Object.entries(r.total)) {
    const p = t.iou05;
    if (p.tp + p.fn !== r.sequences.reduce((a, s) => a + s.results[k].iou05.tp + s.results[k].iou05.fn, 0))
      throw new Error(`${k}: итог не сходится с последовательностями`);
  }
  return r as CvReal;
}

/** Подпись конфигурации: детектор и маска дороги. */
export function realConfigLabel(key: string): string {
  const [det, mask] = key.split('+');
  const name = det === 'background' ? 'классический (вычитание фона)' : det === 'yolox_tiny' ? 'нейросеть YOLOX-tiny' : det;
  return mask ? `${name}, маска дороги` : name;
}
