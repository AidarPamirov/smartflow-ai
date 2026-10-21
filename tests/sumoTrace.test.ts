import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { frameAt, parseResults, parseTrace, validateTrace, vehiclesAt, type Trace } from '../src/sumo/trace';

const DATA = new URL('../public/data/sumo/', import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, DATA), 'utf8'));

describe('данные эксперимента SUMO (public/data/sumo)', () => {
  const traces = { fixed: parseTrace(load('trace-fixed.json')), adaptive: parseTrace(load('trace-adaptive.json')) };
  const results = parseResults(load('results.json'));

  it('обе записи проходят проверку формата и описывают одно и то же окно и сеть', () => {
    for (const [k, tr] of Object.entries(traces)) {
      assert.deepEqual(validateTrace(tr), [], k);
      assert.equal(tr.meta.controller, k);
    }
    assert.deepEqual(traces.fixed.meta.window, traces.adaptive.meta.window);
    assert.equal(traces.fixed.meta.seed, traces.adaptive.meta.seed);
    assert.equal(traces.fixed.meta.load, traces.adaptive.meta.load);
    assert.deepEqual(traces.fixed.geometry, traces.adaptive.geometry);
    assert.equal(traces.fixed.frames.length, traces.adaptive.frames.length);
  });

  it('ни в одном кадре не горят зелёные двум конфликтующим связям (по движениям записи)', () => {
    // Проверка строже реальной: движения соседних подходов всегда считаются конфликтующими,
    // у встречных подходов — левый против прямого или правого (пересечение или слияние в один выезд).
    const opp: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const ok = (a: string, b: string) => {
      if (a[0] === b[0]) return true;
      const pair = [a[1], b[1]].sort().join('');
      if (opp[a[0]] === b[0]) return pair !== 'LT' && pair !== 'LR';
      return false;
    };
    for (const tr of Object.values(traces)) {
      const mv = tr.geometry.links.map((l) => l.movement);
      for (const f of tr.frames) {
        const green = [...f.signal].flatMap((c, i) => (c === 'G' || c === 'g' ? [mv[i]] : []));
        for (let i = 0; i < green.length; i++)
          for (let j = i + 1; j < green.length; j++)
            assert.ok(ok(green[i], green[j]), `${tr.meta.controller} t=${f.t}: ${green[i]} и ${green[j]} одновременно зелёные`);
      }
    }
  });

  it('интерполяция машин между кадрами SUMO', () => {
    const tr = traces.adaptive;
    const a = tr.frames[10], b = tr.frames[11];
    const atA = vehiclesAt(tr, a.t);
    assert.equal(atA.length, a.v.length / 5);
    assert.equal(frameAt(tr, a.t + 0.5), a);
    const mid = vehiclesAt(tr, (a.t + b.t) / 2);
    const idx = (v: number[]) => new Map(Array.from({ length: v.length / 5 }, (_, k) => [v[k * 5], k * 5] as const));
    const ai = idx(a.v), bi = idx(b.v);
    let checked = 0;
    for (const v of mid) {
      const i = ai.get(v.id)!, j = bi.get(v.id);
      if (j === undefined) continue;
      assert.ok(Math.abs(v.x - (a.v[i + 1] + b.v[j + 1]) / 2) < 1e-9);
      checked++;
    }
    assert.ok(checked > 0);
  });

  it('журнал решений в записи: внутри окна, у каждой смены фазы есть причина', () => {
    for (const tr of Object.values(traces)) {
      const ds = tr.decisions ?? [];
      assert.ok(ds.length > 3, `${tr.meta.controller}: решений ${ds.length}`);
      const [w0, w1] = tr.meta.window;
      for (const d of ds) {
        assert.ok(d.time >= w0 && d.time <= w1);
        assert.ok(d.reason.length > 5);
        assert.ok(d.to_phase >= 0 && d.to_phase < tr.phases.length);
      }
    }
  });

  it('новые метрики: перцентиль не меньше среднего ожидания, худший подход не лучше среднего', () => {
    for (const r of results.summary) {
      assert.ok(r.p95_travel_time && r.p95_travel_time[0]! > r.mean_wait[0]!);
      assert.ok(r.worst_approach_wait && r.worst_approach_wait[0]! >= r.mean_wait[0]! - 0.05, "среднее по подходам не больше худшего подхода");
      assert.equal(r.safety_overrides, 0);
      assert.equal(r.fallbacks, 0);
    }
  });

  it('сводка: все контроллеры на каждой нагрузке, без столкновений и конфликтов, все поездки завершены', () => {
    const loads = Object.keys(results.params.loads_veh_h);
    assert.ok(loads.length >= 3);
    assert.deepEqual(results.params.controllers, ['fixed', 'fixed_tuned', 'adaptive']);
    assert.ok(results.params.seeds.length >= 30, 'не меньше 30 повторов на сценарий');
    for (const l of loads)
      for (const c of results.params.controllers) {
        const r = results.summary.find((x) => x.load === l && x.controller === c);
        assert.ok(r, `${l}/${c}`);
        assert.equal(r.runs, results.params.seeds.length);
        assert.equal(r.collisions, 0);
        assert.equal(r.conflict_steps, 0);
        assert.equal(r.unfinished[0], 0);
        assert.ok(r.min_yellow_seen >= results.params.timing.yellow);
        assert.ok(r.min_green_seen >= results.params.timing.min_green);
      }
  });
});

describe('парные сравнения согласованы с сырыми прогонами', () => {
  const results = parseResults(load('results.json'));
  const runs = (results as unknown as { runs: { load: string; controller: string; seed: number; mean_wait: number; demand_vehicles: number }[] }).runs;

  it('маршруты общие: у всех контроллеров одного seed одинаковое число машин и записан хеш файла маршрутов', () => {
    for (const l of Object.keys(results.params.loads_veh_h))
      for (const s of results.params.seeds) {
        const n = new Set(runs.filter((r) => r.load === l && r.seed === s).map((r) => r.demand_vehicles));
        assert.equal(n.size, 1, `${l}/${s}`);
        assert.match(results.params.routes_sha256[`${l}/${s}`], /^[0-9a-f]{64}$/);
      }
  });

  it('разность ожидания «адаптивный − фиксированный» пересчитывается из прогонов', () => {
    for (const l of Object.keys(results.params.loads_veh_h)) {
      const c = results.comparisons.find((x) => x.load === l && x.a === 'adaptive' && x.b === 'fixed' && x.metric === 'mean_wait')!;
      const d = results.params.seeds.map((s) => {
        const a = runs.find((r) => r.load === l && r.controller === 'adaptive' && r.seed === s)!;
        const f = runs.find((r) => r.load === l && r.controller === 'fixed' && r.seed === s)!;
        return a.mean_wait - f.mean_wait;
      });
      const mean = d.reduce((x, y) => x + y, 0) / d.length;
      assert.ok(Math.abs(mean - c.diff) < 0.01, `${l}: ${mean} против ${c.diff}`);
      assert.equal(c.n, results.params.seeds.length);
      assert.equal(c.a_better + c.a_worse + c.ties, c.n);
    }
  });

  it('параметры адаптивного записаны те, с которыми он работал: максимум 1,5 × зелёного плана', () => {
    const g = results.params.fixed.greens_s;
    const m = results.params.adaptive.max_green_by_phase!;
    assert.equal(m.length, g.length);
    // округление в Python банковское (22,5 → 22), поэтому сравнение с допуском 0,5 с
    m.forEach((x, i) => assert.ok(x >= 15 && Math.abs(x - Math.max(15, 1.5 * g[i])) <= 0.5, `фаза ${i + 1}: ${x} против ${1.5 * g[i]}`));
  });
});

describe('проверка формата отклоняет битые записи', () => {
  const good = load('trace-fixed.json') as Trace;
  const clone = (): Trace => JSON.parse(JSON.stringify(good));

  it('неверный формат и контроллер', () => {
    assert.ok(validateTrace({ ...clone(), format: 'x' }).length);
    const t = clone();
    (t.meta as { controller: string }).controller = 'ai';
    assert.ok(validateTrace(t).length);
  });
  it('строка сигнала не той длины, время назад, неполная машина', () => {
    let t = clone();
    t.frames[3].signal = 'G';
    assert.ok(validateTrace(t).length);
    t = clone();
    t.frames[5].t = t.frames[4].t;
    assert.ok(validateTrace(t).length);
    t = clone();
    t.frames[2].v = t.frames[2].v.concat([1, 2]);
    assert.ok(validateTrace(t).length);
    assert.throws(() => parseTrace(t));
  });
  it('результаты без сводки', () => {
    assert.throws(() => parseResults({ format: 'smartflow-sumo-results/2', summary: [] }));
    assert.throws(() => parseResults({ format: 'smartflow-sumo-results/1', summary: [{}], params: {}, scenario: {} }));
  });
});
