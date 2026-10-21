/**
 * Виртуальный план фаз городского светофора. ПРИБЛИЖЕНИЕ: программы реальных светофоров Бишкека
 * в открытых данных нет, поэтому план строится по геометрии подходов.
 *
 *  - фазы: въездные подходы, примерно противоположные друг другу (180° ± PAIR_TOLERANCE_DEG), едут в одной фазе,
 *    остальные — каждый в своей; главная дорога — первой;
 *  - зелёный распределяется по «весу» фазы: класс дороги × число полос на въезд (если известно);
 *  - цикл зависит от старшего класса дорог на перекрёстке; жёлтый 3 с и «все красные» 2 с — как в лаборатории и SUMO;
 *  - если по геометрии получилась одна фаза (светофор у перехода на прямом участке или боковая улица только
 *    на выезд), добавляется виртуальная пешеходная фаза PED_GREEN с: все въезды стоят;
 *  - сдвиг цикла (offset) у каждого светофора свой, детерминированный по ID: город не «мигает» синхронно.
 * Одновременно зелёный горит только одной фазе; конфликты поворотов внутри фазы (левый со встречным прямым)
 * городская демо-модель не различает — это отмечено в интерфейсе.
 */
import type { RoadClass } from '../traffic/network';
import { ALL_RED, YELLOW, type SignalStage } from '../sim/signalMachine';
import { angleDiff, type Leg, type SignalSite } from './inventory';

export const PAIR_TOLERANCE_DEG = 40;
export const MIN_GREEN = 10;
export const MAX_GREEN = 60;
export const LOST_PER_PHASE = YELLOW + ALL_RED;
export const PED_GREEN = 15;

const CLASS_WEIGHT: Record<RoadClass, number> = { motorway: 1.3, trunk: 1.2, primary: 1, secondary: 0.8, tertiary: 0.65, unclassified: 0.5 };
const CLASS_RANK: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'];
const CYCLE_BY_CLASS: Record<RoadClass, number> = { motorway: 100, trunk: 100, primary: 90, secondary: 75, tertiary: 60, unclassified: 60 };

const SECTORS = ['с севера', 'с северо-востока', 'с востока', 'с юго-востока', 'с юга', 'с юго-запада', 'с запада', 'с северо-запада'];
const SHORT = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export const sectorOf = (bearing: number) => Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
export const fromWhere = (bearing: number) => SECTORS[sectorOf(bearing)];

export interface PhaseGroup {
  /** Индексы подходов site.legs, которые получают зелёный в этой фазе (пусто у пешеходной фазы). */
  legs: number[];
  label: string;
  weight: number;
  /** Виртуальная пешеходная фаза: все въезды стоят. */
  pedestrian?: boolean;
}

export interface FixedTiming {
  greens: number[];
  cycle: number;
  offset: number;
}

const legWeight = (l: Leg) => CLASS_WEIGHT[l.cls] * Math.max(1, l.lanesIn || 1);

/** Фазы по геометрии подходов (только подходы с въездом). */
export function phaseGroups(site: SignalSite): PhaseGroup[] {
  const ins = site.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.inbound.length > 0);
  // пары «примерно противоположных» подходов: жадно, начиная с лучшего совпадения
  const cand: { a: number; b: number; dev: number }[] = [];
  for (let p = 0; p < ins.length; p++)
    for (let q = p + 1; q < ins.length; q++) {
      const dev = Math.abs(angleDiff(ins[p].l.bearing, ins[q].l.bearing) - 180);
      if (dev <= PAIR_TOLERANCE_DEG) cand.push({ a: ins[p].i, b: ins[q].i, dev });
    }
  cand.sort((x, y) => x.dev - y.dev);
  const used = new Set<number>();
  const groups: PhaseGroup[] = [];
  for (const c of cand) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a); used.add(c.b);
    groups.push(makeGroup(site, [c.a, c.b]));
  }
  for (const { i } of ins) if (!used.has(i)) groups.push(makeGroup(site, [i]));
  // главная дорога (старший класс, затем больший вес) — первой
  const rank = (g: PhaseGroup) => Math.min(...g.legs.map((i) => CLASS_RANK.indexOf(site.legs[i].cls)));
  groups.sort((x, y) => rank(x) - rank(y) || y.weight - x.weight);
  if (groups.length === 1) groups.push({ legs: [], label: 'пешеходы (виртуальная фаза: все въезды стоят)', weight: 0, pedestrian: true });
  return groups;
}

function makeGroup(site: SignalSite, legs: number[]): PhaseGroup {
  legs.sort((a, b) => site.legs[a].bearing - site.legs[b].bearing);
  const ls = legs.map((i) => site.legs[i]);
  const names = [...new Set(ls.map((l) => l.name).filter(Boolean))];
  const dirs = ls.map((l) => SHORT[sectorOf(l.bearing)]).join('–');
  const label = legs.length === 1
    ? `${ls[0].name || 'подход'} ${fromWhere(ls[0].bearing)}`
    : `${names.join(' / ') || 'подходы'} (${dirs})`;
  return { legs, label, weight: Math.max(...ls.map(legWeight)) };
}

/** Детерминированный сдвиг цикла по ID (FNV-1a). */
export function offsetOf(id: string, cycle: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % Math.max(1, Math.round(cycle));
}

/** Фиксированный план: целые секунды зелёного, MIN_GREEN…MAX_GREEN на фазу. */
export function fixedTiming(site: SignalSite, groups: PhaseGroup[]): FixedTiming {
  if (!groups.length) return { greens: [], cycle: 0, offset: 0 };
  const top = site.legs.map((l) => l.cls).sort((a, b) => CLASS_RANK.indexOf(a) - CLASS_RANK.indexOf(b))[0];
  const target = CYCLE_BY_CLASS[top];
  const eff = Math.max(MIN_GREEN * groups.length, target - LOST_PER_PHASE * groups.length);
  const veh = groups.filter((g) => !g.pedestrian);
  const effVeh = eff - (groups.length - veh.length) * PED_GREEN;
  const sum = veh.reduce((a, g) => a + g.weight, 0) || 1;
  const greens = groups.map((g) => (g.pedestrian ? PED_GREEN : Math.min(MAX_GREEN, Math.max(MIN_GREEN, Math.round((effVeh * g.weight) / sum)))));
  const cycle = greens.reduce((a, g) => a + g, 0) + LOST_PER_PHASE * groups.length;
  return { greens, cycle, offset: offsetOf(site.id, cycle) };
}

export interface PlanPoint { phase: number; next: number; stage: SignalStage; elapsed: number; remaining: number }

/** Положение фиксированного плана в момент t (секунды от начала модели с учётом сдвига). */
export function fixedStateAt(timing: FixedTiming, t: number): PlanPoint {
  const n = timing.greens.length;
  if (!n) return { phase: 0, next: 0, stage: 'allred', elapsed: 0, remaining: Infinity };
  let u = (((t + timing.offset) % timing.cycle) + timing.cycle) % timing.cycle;
  for (let k = 0; k < n; k++) {
    const g = timing.greens[k];
    const next = (k + 1) % n;
    if (u < g) return { phase: k, next, stage: 'green', elapsed: u, remaining: g - u };
    u -= g;
    if (u < YELLOW) return { phase: k, next, stage: 'yellow', elapsed: u, remaining: YELLOW - u };
    u -= YELLOW;
    if (u < ALL_RED) return { phase: k, next, stage: 'allred', elapsed: u, remaining: ALL_RED - u };
    u -= ALL_RED;
  }
  return { phase: 0, next: 1 % n, stage: 'green', elapsed: 0, remaining: timing.greens[0] };
}
