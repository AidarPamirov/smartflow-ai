import { MANEUVERS, type Dir, type Maneuver } from './geometry';

export interface Sample {
  t: number;
  /** Очередь по типам манёвров (все въезды вместе). */
  queue: Record<Maneuver, number>;
  served: number;
  /** Среднее ожидание обслуженных на момент t (null — ещё никто не проехал). */
  avgWait: number | null;
}

export interface ManeuverStats {
  served: number;
  avgWait: number | null;
  maxQueue: number;
}

export interface Summary {
  t: number;
  served: number;
  inSystem: number;
  avgWait: number | null;
  avgDelay: number | null;
  maxQueue: number;
  /** Обслужено авто/ч за прошедшее время; null, если прошло меньше минуты. */
  throughput: number | null;
  byManeuver: Record<Maneuver, ManeuverStats>;
  safety: Safety;
}

export interface Safety {
  /** Шаги, на которых две машины конфликтующих маршрутов одновременно находились в общей зоне. */
  zoneViolations: number;
  /** Пары кузовов, пересёкшихся геометрически (проверка прямоугольников). */
  overlaps: number;
  /** Пересечения стоп-линии на красный. */
  redViolations: number;
  /** Срабатывания аварийного ограничения позиции (модель следования не справилась). */
  interventions: number;
  /** Минимальный зазор до лидера за прогон, м. */
  minGap: number;
  /** Сколько защищённых машин хотя бы раз ждали уступающую машину, уже занявшую зону. */
  priorityBlocked: number;
}

const zeroBy = <T>(f: () => T): Record<Maneuver, T> =>
  ({ T: f(), L: f(), R: f(), U: f() });

export class Metrics {
  served = 0;
  sumWait = 0;
  sumDelay = 0;
  maxQueue = 0;
  maxQueueByDir: Record<Dir, number> = { N: 0, E: 0, S: 0, W: 0 };
  servedBy = zeroBy(() => 0);
  waitBy = zeroBy(() => 0);
  maxQueueBy = zeroBy(() => 0);
  samples: Sample[] = [];
  safety: Safety = { zoneViolations: 0, overlaps: 0, redViolations: 0, interventions: 0, minGap: Infinity, priorityBlocked: 0 };

  recordServed(man: Maneuver, wait: number, delay: number): void {
    this.served++;
    this.sumWait += wait;
    this.sumDelay += Math.max(0, delay);
    this.servedBy[man]++;
    this.waitBy[man] += wait;
  }

  recordQueues(byDir: Record<Dir, number>, byMan: Record<Maneuver, number>): void {
    for (const d of Object.keys(byDir) as Dir[]) {
      this.maxQueueByDir[d] = Math.max(this.maxQueueByDir[d], byDir[d]);
      this.maxQueue = Math.max(this.maxQueue, byDir[d]);
    }
    for (const m of MANEUVERS) this.maxQueueBy[m] = Math.max(this.maxQueueBy[m], byMan[m]);
  }

  get avgWait(): number | null {
    return this.served > 0 ? this.sumWait / this.served : null;
  }

  summary(t: number, inSystem: number): Summary {
    const byManeuver = zeroBy<ManeuverStats>(() => ({ served: 0, avgWait: null, maxQueue: 0 }));
    for (const m of MANEUVERS)
      byManeuver[m] = {
        served: this.servedBy[m],
        avgWait: this.servedBy[m] > 0 ? this.waitBy[m] / this.servedBy[m] : null,
        maxQueue: this.maxQueueBy[m],
      };
    return {
      t,
      served: this.served,
      inSystem,
      avgWait: this.avgWait,
      avgDelay: this.served > 0 ? this.sumDelay / this.served : null,
      maxQueue: this.maxQueue,
      throughput: t >= 60 ? (this.served / t) * 3600 : null,
      byManeuver,
      safety: { ...this.safety },
    };
  }
}
