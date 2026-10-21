import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Fleet, QUEUE_SPEED, type SignalHook } from '../src/traffic/fleet';
import { parseNetwork } from '../src/traffic/network';
import { RouteGenerator } from '../src/traffic/routing';
import { parseOsmSignals } from '../src/signals/inventory';
import { SignalSystem } from '../src/signals/system';
import { cityObserve } from '../src/signals/observe';

/**
 * Демо-трафик центра Бишкека вместе с виртуальными светофорами: машины не проезжают на красный,
 * очереди появляются и рассасываются, город не «запирается». Синтетика — проверяется поведение модели, а не реальность.
 */
describe('демо-трафик и светофоры (реальные данные OSM)', () => {
  const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/bishkek-roads.json', import.meta.url), 'utf8')));
  const osm = parseOsmSignals(JSON.parse(readFileSync(new URL('../public/data/bishkek-signals-osm.json', import.meta.url), 'utf8')));
  const gen = new RouteGenerator(net, 2026);
  const pool = Array.from({ length: 120 }, () => gen.next()!);
  const cont = new RouteGenerator(net, 2027);

  function run(mode: 'fixed' | 'adaptive', minutes: number) {
    const sys = new SignalSystem(net, osm);
    sys.setModeAll(mode);
    const hook: SignalHook = { controlled: (k) => sys.byArc.has(k), light: (k) => sys.lightForArc(k) };
    const fleet = new Fleet(pool, 2026, 600, (r, a) => !net.edges[r.arcs[a].edge].oneway, (n) => cont.from(n), hook);
    let violations = 0, maxQueue = 0, queuedSamples = 0, crossings = 0;
    const tripsAt: number[] = [];
    const dt = 0.5;
    for (let k = 0; k < (minutes * 60) / dt; k++) {
      const before = fleet.vehicles.map((v) => {
        const ai = v.stopKey >= 0 ? v.route.arcs.findIndex((a, i) => i >= v.arc && a.edge * 2 + (a.forward ? 0 : 1) === v.stopKey) : -1;
        return { v, s: v.s, ai, d: v.stopD, light: v.stopKey >= 0 ? sys.lightForArc(v.stopKey) : null, route: v.route };
      });
      fleet.step(dt);
      for (const b of before) {
        if (b.ai < 0 || b.v.route !== b.route) continue;
        const crossed = b.d >= 0 && b.v.s - b.s > b.d + 1e-6;
        // проезд на красный допустим только для машины, которая решила ехать ещё на жёлтый (не успевала остановиться)
        if (crossed && b.light === 'R' && b.v.goArc !== b.ai) violations++;
        if (crossed) crossings++;
      }
      const obs = fleet.approachObs();
      sys.step(dt, (it) => cityObserve(it, obs, sys.t));
      for (const o of obs.values()) { maxQueue = Math.max(maxQueue, o.queue); if (o.queue > 0) queuedSamples++; }
      if (k % 120 === 0) tripsAt.push(fleet.trips);
    }
    return { fleet, sys, violations, maxQueue, queuedSamples, tripsAt, crossings };
  }

  const fixed = run('fixed', 20);

  it('на красный никто не въезжает', () => {
    assert.ok(fixed.crossings > 1000, `проездов стоп-линий ${fixed.crossings}`);
    assert.equal(fixed.violations, 0);
  });

  it('у светофоров появляются очереди, и город не «запирается»', () => {
    assert.ok(fixed.maxQueue >= 3, `макс. очередь ${fixed.maxQueue}`);
    assert.ok(fixed.queuedSamples > 0);
    const t = fixed.tripsAt;
    // в каждом 5-минутном отрезке после первого поездки продолжают завершаться
    for (let i = 6; i < t.length; i += 5) assert.ok(t[i] > t[i - 5], `поездки остановились к ${i} мин`);
    const moving = fixed.fleet.vehicles.filter((v) => v.v >= QUEUE_SPEED).length;
    assert.ok(moving > fixed.fleet.vehicles.length * 0.3, `едет только ${moving}`);
  });

  it('адаптивный режим тоже безопасен и пишет причины решений', () => {
    const a = run('adaptive', 10);
    assert.equal(a.violations, 0);
    const reasons = a.sys.items.flatMap((it) => it.rt?.log ?? []).map((d) => d.reason);
    assert.ok(reasons.some((r) => /разрыв потока|давление|максимум/.test(r)), 'нет решений адаптивного контроллера');
    assert.ok(!reasons.some((r) => /ошибка адаптивного/.test(r)), 'адаптивный контроллер падал');
  });
});
