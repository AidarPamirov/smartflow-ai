/**
 * Парные сравнения контроллеров (пишет sumo/smartflow_sumo/stats.py): разность по одинаковым seed,
 * 95 % доверительный интервал и в скольких seed один контроллер лучше другого. Только данные и вывод — без отрисовки.
 */

export interface Comparison {
  load: string;
  /** «A против B»: разность = A − B. */
  a: string;
  b: string;
  metric: string;
  lower_is_better: boolean;
  n: number;
  mean_a: number;
  mean_b: number;
  sd_a: number;
  sd_b: number;
  diff: number;
  diff_ci95: [number, number];
  sd_diff: number;
  /** (A − B) / среднее B; null — среднее B равно 0. */
  rel: number | null;
  rel_ci95: [number | null, number | null];
  a_better: number;
  a_worse: number;
  ties: number;
  p_sign: number;
}

export type Verdict = 'better' | 'worse' | 'same' | 'unclear';

/**
 * Вывод по 95 % ДИ разности: «лучше» или «хуже», только если интервал целиком по одну сторону от нуля;
 * «одинаково» — все seed дали одно и то же; иначе разница статистически не подтверждена.
 */
export function verdict(c: Comparison): Verdict {
  if (c.ties === c.n) return 'same';
  const [lo, hi] = c.diff_ci95;
  const good = c.lower_is_better ? hi < 0 : lo > 0;
  const bad = c.lower_is_better ? lo > 0 : hi < 0;
  return good ? 'better' : bad ? 'worse' : 'unclear';
}

export function findComparison(list: Comparison[] | undefined, load: string, a: string, b: string, metric: string): Comparison | undefined {
  return list?.find((c) => c.load === load && c.a === a && c.b === b && c.metric === metric);
}

export function parseComparisons(d: unknown): Comparison[] {
  if (!Array.isArray(d)) throw new Error('comparisons должен быть списком');
  for (const c of d as Comparison[]) {
    if (typeof c.diff !== 'number' || !Array.isArray(c.diff_ci95) || c.diff_ci95.length !== 2 || !(c.diff_ci95[0] <= c.diff && c.diff <= c.diff_ci95[1]))
      throw new Error(`сравнение ${c.a}/${c.b}/${c.metric}: разность вне своего интервала`);
    if (c.a_better + c.a_worse + c.ties !== c.n) throw new Error(`сравнение ${c.a}/${c.b}/${c.metric}: число seed не сходится`);
  }
  return d as Comparison[];
}
