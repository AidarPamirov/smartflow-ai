/**
 * Загруженность участков по синтетическому трафику: отношение скорости машин к условной скорости свободного
 * движения класса дороги (CLASS_SPEED), сглаженное во времени. Это показатель МОДЕЛИ, не реальных пробок.
 *
 * Уровни: 0 — свободно (≥ 75 % от свободной скорости), 1 — 50–75 %, 2 — 25–50 %, 3 — < 25 % (почти стоят),
 * −1 — нет данных (по участку давно никто не проезжал).
 */
import type { Vehicle } from './fleet';
import { toLonLat, type Network } from './network';
import { CLASS_SPEED } from './routing';

export const TAU_S = 60;
export const STALE_S = 120;
export const LEVELS = [0.75, 0.5, 0.25] as const;
export const LEVEL_COLOR = ['#2fd17c', '#ffc533', '#ff8a3d', '#ff3b3b'] as const;
export const LEVEL_LABEL = ['свободно', 'плотно', 'медленно', 'почти стоят'] as const;

export function levelOf(ratio: number): 0 | 1 | 2 | 3 {
  if (ratio >= LEVELS[0]) return 0;
  if (ratio >= LEVELS[1]) return 1;
  if (ratio >= LEVELS[2]) return 2;
  return 3;
}

export class CongestionMeter {
  private ratio = new Map<number, number>();
  private seen = new Map<number, number>();
  t = 0;

  constructor(private net: Network) {}

  reset() { this.ratio.clear(); this.seen.clear(); this.t = 0; }

  /** Учесть кадр: средняя по машинам доля свободной скорости на каждом направленном участке. */
  update(vehicles: readonly Vehicle[], dt: number) {
    if (dt <= 0) return;
    this.t += dt;
    const sum = new Map<number, [number, number]>();
    for (const v of vehicles) {
      const a = v.route.arcs[v.arc];
      const key = a.edge * 2 + (a.forward ? 0 : 1);
      const free = CLASS_SPEED[this.net.edges[a.edge].cls];
      const r = Math.min(1.2, v.v / free);
      const s = sum.get(key);
      if (s) { s[0] += r; s[1]++; } else sum.set(key, [r, 1]);
    }
    const k = Math.min(1, dt / TAU_S);
    for (const [key, [r, n]] of sum) {
      const cur = r / n;
      const prev = this.ratio.get(key);
      this.ratio.set(key, prev === undefined ? cur : prev + (cur - prev) * k);
      this.seen.set(key, this.t);
    }
  }

  /** Доля свободной скорости или null, если данных нет. */
  ratioOf(key: number): number | null {
    const s = this.seen.get(key);
    if (s === undefined || this.t - s > STALE_S) return null;
    return this.ratio.get(key) ?? null;
  }

  /** Сколько участков в каждом уровне (для легенды). */
  histogram(): number[] {
    const h = [0, 0, 0, 0, 0]; // 4 уровня + нет данных
    for (let e = 0; e < this.net.edges.length; e++)
      for (const f of [true, false]) {
        if (!f && this.net.edges[e].oneway) continue;
        const r = this.ratioOf(e * 2 + (f ? 0 : 1));
        h[r === null ? 4 : levelOf(r)]++;
      }
    return h;
  }

  /** Линии с уровнем загруженности; направление — по ходу движения (для смещения вправо на двусторонних улицах). */
  geojson() {
    const features = [];
    for (const e of this.net.edges)
      for (const fwd of [true, false]) {
        if (!fwd && e.oneway) continue;
        const r = this.ratioOf(e.id * 2 + (fwd ? 0 : 1));
        if (r === null) continue;
        const coords: [number, number][] = [];
        const k = e.xs.length;
        for (let j = 0; j < k; j++) { const i = fwd ? j : k - 1 - j; coords.push(toLonLat(this.net.proj, e.xs[i], e.ys[i])); }
        features.push({ type: 'Feature' as const, properties: { l: levelOf(r), two: e.oneway ? 0 : 1 }, geometry: { type: 'LineString' as const, coordinates: coords } });
      }
    return { type: 'FeatureCollection' as const, features };
  }
}
