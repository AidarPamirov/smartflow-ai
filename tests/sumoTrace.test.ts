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

  it('сводка: оба контроллера на каждой нагрузке, без столкновений и конфликтов, все поездки завершены', () => {
    const loads = Object.keys(results.params.loads_veh_h);
    assert.ok(loads.length >= 3);
    for (const l of loads)
      for (const c of ['fixed', 'adaptive'] as const) {
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
    assert.throws(() => parseResults({ format: 'smartflow-sumo-results/1', summary: [] }));
  });
});
