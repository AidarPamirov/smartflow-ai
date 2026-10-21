import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CORRIDOR_CTRLS, maxFill, nodeQueue, parseCorridor, spillTotal } from '../src/sumo/corridor';

describe('результаты коридора SUMO (public/data/sumo/corridor-results.json)', () => {
  const data = parseCorridor(JSON.parse(readFileSync(new URL('../public/data/sumo/corridor-results.json', import.meta.url), 'utf8')));

  it('четыре способа управления на каждой нагрузке, одинаковый спрос и общий файл маршрутов', () => {
    assert.deepEqual(data.params.controllers, [...CORRIDOR_CTRLS]);
    assert.ok(data.params.seeds.length >= 10, 'не меньше 10 повторов');
    for (const l of [...Object.keys(data.params.loads_veh_h), 'incident']) {
      const rows = data.summary.filter((r) => r.load === l);
      assert.deepEqual(rows.map((r) => r.controller).sort(), [...CORRIDOR_CTRLS].sort());
      for (const s of data.params.seeds) assert.match(data.params.routes_sha256[`${l}/${s}`], /^[0-9a-f]{64}$/);
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

  it('очереди по подходам складываются в очередь узла; ожидание по въездам есть для поперечных улиц', () => {
    for (const r of data.summary.filter((x) => x.load !== 'incident')) {
      for (const n of data.corridor.nodes) {
        const sum = nodeQueue(r, n.id, 'main')! + nodeQueue(r, n.id, 'cross')!;
        assert.ok(Math.abs(sum - r.queue_by_node[n.id][0]!) < 0.05 + 0.01 * sum, `${r.load}/${r.controller}/${n.id}: ${sum} против ${r.queue_by_node[n.id][0]}`);
      }
      assert.ok(r.side_wait[0] != null && r.main_wait[0] != null);
      assert.ok(r.wait_by_entry.MAN_N);
    }
  });

  it('парные сравнения есть для каждой нагрузки и согласованы по числу seed', () => {
    for (const l of Object.keys(data.params.loads_veh_h)) {
      const c = data.comparisons.find((x) => x.load === l && x.a === 'adaptive' && x.b === 'coordinated' && x.metric === 'side_wait');
      assert.ok(c, l);
      assert.equal(c.n, data.params.seeds.length);
      assert.ok(c.diff_ci95[0] <= c.diff && c.diff <= c.diff_ci95[1]);
    }
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
