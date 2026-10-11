/** Детерминированный ГПСЧ (mulberry32). Одинаковый seed → одинаковая последовательность. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Независимый поток для каждого подхода: прибытия не зависят от контроллера. */
export function streamSeed(seed: number, salt: number): number {
  return (Math.imul(seed >>> 0, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
}

/** Экспоненциальный интервал между прибытиями (поток Пуассона), rate — авто/ч. */
export function expInterval(rng: Rng, ratePerHour: number): number {
  if (ratePerHour <= 0) return Infinity;
  const u = rng();
  return -Math.log(1 - u) / (ratePerHour / 3600);
}
