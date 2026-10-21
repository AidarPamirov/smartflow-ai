/**
 * Проверка цифры «час пик на карте: Baseline против адаптивного» на нескольких seed (синтетика, не SUMO).
 *
 *   npx tsx scripts/rush-check.ts [seeds=10] [минут=20] > public/data/city/rush-check.json
 *
 * Та же модель, что на карте: сеть OSM, светофоры OSM, спрос «утренний час пик», 3000 машин. Для каждого seed оба режима
 * получают одинаковые маршруты и одинаковую расстановку машин; сравнение парное. Средняя скорость считается
 * по второй половине прогона (первая — разогрев). Проезды на красный считаются для проверки безопасности.
 */
import { readFileSync } from 'node:fs';
import { Fleet, type SignalHook } from '../src/traffic/fleet';
import { parseNetwork } from '../src/traffic/network';
import { RouteGenerator, type DemandMode } from '../src/traffic/routing';
import { parseOsmSignals } from '../src/signals/inventory';
import { SignalSystem } from '../src/signals/system';
import { cityObserve } from '../src/signals/observe';

const SEEDS = Number(process.argv[2] ?? 10);
const MINUTES = Number(process.argv[3] ?? 20);
const COUNT = 3000;
const DEMAND: DemandMode = 'morning';
const DT = 0.5;

const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/bishkek-roads.json', import.meta.url), 'utf8')));
const osm = parseOsmSignals(JSON.parse(readFileSync(new URL('../public/data/bishkek-signals-osm.json', import.meta.url), 'utf8')));

function run(seed: number, mode: 'fixed' | 'adaptive') {
  const gen = new RouteGenerator(net, seed, DEMAND);
  const pool = Array.from({ length: 240 }, () => gen.next()!);
  const cont = new RouteGenerator(net, seed + 1, DEMAND);
  const sys = new SignalSystem(net, osm);
  sys.setModeAll(mode);
  const hook: SignalHook = { controlled: (k) => sys.byArc.has(k), light: (k) => sys.lightForArc(k) };
  const fleet = new Fleet(pool, seed, COUNT, (r, a) => !net.edges[r.arcs[a].edge].oneway, (n) => cont.continueTrip(n), hook);
  const steps = (MINUTES * 60) / DT;
  let speed = 0, n = 0, redRuns = 0, trips0 = 0;
  for (let k = 0; k < steps; k++) {
    const before = fleet.vehicles.map((v) => ({ v, s: v.s, d: v.stopD, key: v.stopKey, route: v.route, go: v.goArc }));
    fleet.step(DT);
    for (const b of before) {
      if (b.key < 0 || b.v.route !== b.route || !(b.d >= 0 && b.v.s - b.s > b.d + 1e-6)) continue;
      if (sys.lightForArc(b.key) === 'R' && b.v.goArc < 0 && b.go < 0) redRuns++;
    }
    const obs = fleet.approachObs();
    sys.step(DT, (it) => cityObserve(it, obs, sys.t));
    if (k === steps / 2) trips0 = fleet.trips;
    if (k >= steps / 2) { speed += fleet.stats().meanSpeed; n++; }
  }
  return { speed_kmh: Math.round((speed / n) * 3.6 * 100) / 100, trips: fleet.trips - trips0, red_runs: redRuns };
}

const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093];
function paired(d: number[]) {
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1));
  const h = (T975[d.length - 2] ?? 1.96) * sd / Math.sqrt(d.length);
  return { diff: +m.toFixed(2), ci95: [+(m - h).toFixed(2), +(m + h).toFixed(2)], better: d.filter((x) => x > 0).length, n: d.length };
}

const rows: { seed: number; fixed: ReturnType<typeof run>; adaptive: ReturnType<typeof run> }[] = [];
for (let s = 1; s <= SEEDS; s++) {
  rows.push({ seed: 2025 + s, fixed: run(2025 + s, 'fixed'), adaptive: run(2025 + s, 'adaptive') });
  console.error(`seed ${2025 + s}: Baseline ${rows.at(-1)!.fixed.speed_kmh} км/ч, адаптивный ${rows.at(-1)!.adaptive.speed_kmh} км/ч`);
}
const mean = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
console.log(JSON.stringify({
  format: 'smartflow-city-rush-check/1',
  generated: new Date().toISOString(),
  note: 'Синтетическая модель карты (не SUMO): одна полоса на направление, маршруты без объезда пробок, постоянный спрос часа пик. Иллюстрация, не прогноз.',
  params: { demand: DEMAND, vehicles: COUNT, minutes: MINUTES, dt_s: DT, measured: 'вторая половина прогона', seeds: rows.map((r) => r.seed) },
  summary: {
    fixed_speed_kmh: mean(rows.map((r) => r.fixed.speed_kmh)), adaptive_speed_kmh: mean(rows.map((r) => r.adaptive.speed_kmh)),
    speed_diff: paired(rows.map((r) => r.adaptive.speed_kmh - r.fixed.speed_kmh)),
    trips_diff: paired(rows.map((r) => r.adaptive.trips - r.fixed.trips)),
    red_runs: rows.reduce((a, r) => a + r.fixed.red_runs + r.adaptive.red_runs, 0),
  },
  runs: rows,
}, null, 1));
