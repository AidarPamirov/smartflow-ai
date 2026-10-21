import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { maxFill, parseCorridor, spillTotal } from '../src/sumo/corridor';

describe('результаты коридора SUMO (public/data/sumo/corridor-results.json)', () => {
  const data = parseCorridor(JSON.parse(readFileSync(new URL('../public/data/sumo/corridor-results.json', import.meta.url), 'utf8')));

  it('три способа управления на каждой нагрузке, одинаковый спрос', () => {
    for (const l of [...Object.keys(data.params.loads_veh_h), 'incident']) {
      const rows = data.summary.filter((r) => r.load === l);
      assert.deepEqual(rows.map((r) => r.controller).sort(), ['adaptive', 'coordinated', 'fixed']);
      assert.equal(new Set(rows.map((r) => r.demand_vehicles[0])).size, 1, `${l}: спрос должен совпадать`);
      for (const r of rows) assert.equal(r.runs, data.params.seeds.length);
    }
  });

  it('безопасность и завершённость во всех прогонах', () => {
    for (const r of data.summary) {
      assert.equal(r.collisions, 0, `${r.load}/${r.controller}`);
      assert.equal(r.conflict_steps, 0);
      assert.equal(r.teleports, 0);
      assert.equal(r.safety_overrides, 0);
      assert.equal(r.fallbacks, 0);
      assert.equal(r.unfinished[0], 0);
    }
  });

  it('стресс-сценарий: очередь доходит до соседнего перекрёстка хотя бы при одном способе управления, при обычной нагрузке — нет', () => {
    assert.ok(data.params.incident);
    const inc = data.summary.filter((r) => r.load === 'incident');
    assert.ok(inc.some((r) => spillTotal(r) > 0));
    for (const r of data.summary.filter((x) => x.load !== 'incident')) assert.equal(spillTotal(r), 0, `${r.load}/${r.controller}`);
  });

  it('метрики согласованы: перцентиль ≥ среднего ожидания, заполнение 0…1, сдвиги в пределах цикла', () => {
    for (const r of data.summary) {
      assert.ok(r.p95_travel_time[0]! > r.mean_wait[0]!);
      const f = maxFill(r);
      assert.ok(f >= 0 && f <= 1.5);
      assert.ok(spillTotal(r) >= 0);
    }
    const cyc = data.params.coordinated[0].cycle;
    for (const c of data.params.coordinated) {
      assert.equal(c.cycle, cyc);
      assert.ok(c.offset >= 0 && c.offset < cyc);
    }
    const xs = data.corridor.nodes.map((n) => n.x);
    assert.deepEqual(data.corridor.spacing_m, xs.slice(1).map((x, i) => Math.round(x - xs[i])));
  });
});
