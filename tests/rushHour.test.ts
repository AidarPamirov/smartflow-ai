import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Fleet, type SignalHook } from '../src/traffic/fleet';
import { parseNetwork, toXY } from '../src/traffic/network';
import { CENTER_R, CITY_CENTER, RouteGenerator, type DemandMode } from '../src/traffic/routing';
import { parseOsmSignals } from '../src/signals/inventory';
import { SignalSystem } from '../src/signals/system';
import { cityObserve } from '../src/signals/observe';

/** Сценарий часа пик: направление поездок, въезды по магистралям, безопасность и рост загрузки. Синтетика. */
describe('час пик (синтетический сценарий спроса)', () => {
  const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/bishkek-roads.json', import.meta.url), 'utf8')));
  const osm = parseOsmSignals(JSON.parse(readFileSync(new URL('../public/data/bishkek-signals-osm.json', import.meta.url), 'utf8')));
  const [cx, cy] = toXY(net.proj, CITY_CENTER[0], CITY_CENTER[1]);
  const inCenter = (n: number) => Math.hypot(net.nodeX[n] - cx, net.nodeY[n] - cy) <= CENTER_R;

  const share = (demand: DemandMode, end: 'from' | 'to') => {
    const g = new RouteGenerator(net, 7, demand);
    const rs = Array.from({ length: 300 }, () => g.next()!);
    return rs.filter((r) => inCenter(r[end])).length / rs.length;
  };

  it('утром большинство поездок заканчивается в центре, вечером — начинается там', () => {
    const base = share('uniform', 'to');
    assert.ok(share('morning', 'to') > 0.7, `утро: ${share('morning', 'to')}`);
    assert.ok(share('evening', 'from') > 0.7, `вечер: ${share('evening', 'from')}`);
    assert.ok(base < 0.4, `обычный режим: ${base}`);
  });

  it('въезды — узлы магистралей у края графа; среди них проспект Чынгыза Айтматова на юге', () => {
    const g = new RouteGenerator(net, 1, 'morning');
    assert.ok(g.gates.length >= 8, `въездов ${g.gates.length}`);
    const names = new Set(g.gates.flatMap((n) => net.out[n].map((a) => net.edges[a.edge].name)));
    assert.ok([...names].some((x) => /Айтматов/.test(x) && !/Торекула/.test(x)), [...names].join(', '));
  });

  it('обычный режим не изменился: те же поездки при том же seed', () => {
    const a = new RouteGenerator(net, 2026), b = new RouteGenerator(net, 2026, 'uniform');
    for (let i = 0; i < 20; i++) {
      const x = a.next()!, y = b.next()!;
      assert.deepEqual([x.from, x.to], [y.from, y.to]);
    }
  });

  it('в час пик модель медленнее, никто не едет на красный, Adaptive AI не хуже Baseline', () => {
    function run(demand: DemandMode, count: number, mode: 'fixed' | 'adaptive') {
      const gen = new RouteGenerator(net, 2026, demand);
      const pool = Array.from({ length: 160 }, () => gen.next()!);
      const cont = new RouteGenerator(net, 2027, demand);
      const sys = new SignalSystem(net, osm);
      sys.setModeAll(mode);
      const hook: SignalHook = { controlled: (k) => sys.byArc.has(k), light: (k) => sys.lightForArc(k) };
      const fleet = new Fleet(pool, 2026, count, (r, a) => !net.edges[r.arcs[a].edge].oneway, (n) => cont.continueTrip(n), hook);
      let speed = 0, n = 0, redRuns = 0;
      const dt = 0.5;
      for (let k = 0; k < 1200; k++) {
        const before = fleet.vehicles.map((v) => ({ v, s: v.s, d: v.stopD, key: v.stopKey, route: v.route, go: v.goArc }));
        fleet.step(dt);
        for (const b of before) {
          if (b.key < 0 || b.v.route !== b.route || !(b.d >= 0 && b.v.s - b.s > b.d + 1e-6)) continue;
          if (sys.lightForArc(b.key) === 'R' && b.v.goArc < 0 && b.go < 0) redRuns++;
        }
        const obs = fleet.approachObs();
        sys.step(dt, (it) => cityObserve(it, obs, sys.t));
        if (k >= 600) { speed += fleet.stats().meanSpeed; n++; }
      }
      return { speed: (speed / n) * 3.6, trips: fleet.trips, redRuns };
    }
    const normal = run('uniform', 1000, 'fixed');
    const rush = run('morning', 3000, 'fixed');
    const rushAi = run('morning', 3000, 'adaptive');
    assert.ok(rush.speed < normal.speed - 5, `час пик ${rush.speed.toFixed(1)} против ${normal.speed.toFixed(1)} км/ч`);
    assert.equal(rush.redRuns, 0);
    assert.equal(rushAi.redRuns, 0);
    assert.ok(rushAi.speed >= rush.speed, `Adaptive ${rushAi.speed.toFixed(1)} против Baseline ${rush.speed.toFixed(1)} км/ч`);
  });
});
