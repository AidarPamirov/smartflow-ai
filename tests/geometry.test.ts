import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conflictTable, signalConflict } from '../src/sim/conflicts';
import { DIRS, headingAfter, type Maneuver } from '../src/sim/geometry';
import { buildPlan, unservedMovements, validatePlan, type UturnAllowed } from '../src/sim/phases';
import { DS, PATHS, poseAt } from '../src/sim/routes';

const ALL_U: UturnAllowed = { N: true, E: true, S: true, W: true };
const angDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };

describe('траектории', () => {
  it('20 маршрутов: 4 въезда × (2 прямо + налево + направо + разворот)', () => {
    assert.equal(PATHS.size, 20);
  });
  for (const p of PATHS.values())
    it(`${p.id}: непрерывна, гладкая, заканчивается в нужном направлении`, () => {
      const n = p.xs.length;
      for (let i = 1; i < n; i++) {
        const step = Math.hypot(p.xs[i] - p.xs[i - 1], p.ys[i] - p.ys[i - 1]);
        assert.ok(step > DS * 0.9 && step < DS * 1.1, `шаг ${step} в точке ${i}`);
        assert.ok(angDiff(p.hs[i], p.hs[i - 1]) < 0.15, `излом направления в точке ${i}`);
      }
      const h = headingAfter(p.dir, p.man as Maneuver);
      assert.ok(angDiff(p.hs[n - 1], Math.atan2(h.y, h.x)) < 1e-6, 'конечное направление');
      const mid = poseAt(p, (p.connStart + p.connEnd) / 2);
      assert.ok(Math.abs(mid.x) < 14 && Math.abs(mid.y) < 14, 'соединитель внутри зоны перекрёстка');
    });
  it('скорость на кривой ограничена: разворот ≤ 3 м/с, направо ≤ 5 м/с', () => {
    for (const p of PATHS.values()) {
      if (p.man === 'U') assert.ok(p.vCurveMin <= 3, p.id);
      if (p.man === 'R') assert.ok(p.vCurveMin <= 5, p.id);
      if (p.man === 'T') assert.ok(p.vCurveMin > 13, p.id);
    }
  });
});

describe('конфликты траекторий', () => {
  const T = conflictTable();
  it('таблица симметрична', () => {
    for (const [id, cs] of T) for (const c of cs) assert.ok(T.get(c.other)!.some((x) => x.other === id), `${id}/${c.other}`);
  });
  it('пересекающиеся потоки обнаружены', () => {
    assert.ok(signalConflict('N0T', 'E0T'), 'прямые соседних осей');
    assert.ok(signalConflict('N0L', 'S0T'), 'левый и встречный прямой');
    assert.ok(signalConflict('N0L', 'S1T'));
    assert.ok(signalConflict('N0U', 'S0T'), 'разворот и встречный прямой');
    assert.ok(signalConflict('N1R', 'E1T'), 'слияние направо + прямо в одну полосу');
  });
  it('непересекающиеся потоки не считаются конфликтом', () => {
    assert.ok(!signalConflict('N0T', 'S0T'), 'встречные прямые');
    assert.ok(!signalConflict('N1R', 'S1R'), 'встречные правые');
    assert.ok(!signalConflict('N0L', 'S0L'), 'встречные левые расходятся');
    assert.ok(!signalConflict('N1R', 'S0L'), 'правый и встречный левый — разные полосы выезда');
  });
  it('расхождение из одной полосы фиксируется как зона, но не сигнальный конфликт', () => {
    const c = T.get('N0L')!.find((x) => x.other === 'N0T');
    assert.equal(c?.kind, 'diverge');
    assert.ok(!signalConflict('N0L', 'N0T'));
  });
});

describe('светофорные фазы', () => {
  for (const mode of ['permissive', 'protected'] as const)
    for (const [label, ut] of [['без разворотов', { N: false, E: false, S: false, W: false }], ['с разворотами', ALL_U]] as const)
      it(`${mode}, ${label}: нет одновременно защищённых конфликтующих потоков, все маршруты обслуживаются`, () => {
        const plan = buildPlan(mode, ut as UturnAllowed);
        assert.deepEqual(validatePlan(plan), []);
        assert.deepEqual(unservedMovements(plan, ut as UturnAllowed), []);
      });
  it('разрешённый режим: левый поворот уступает встречному прямому', () => {
    const [ns] = buildPlan('permissive', ALL_U);
    assert.equal(ns.status.get('N0T'), 'P');
    assert.equal(ns.status.get('N0L'), 'Y');
    assert.equal(ns.status.get('N0U'), 'Y');
  });
  it('защищённый режим: отдельная фаза, встречные левые защищены одновременно', () => {
    const plan = buildPlan('protected', ALL_U);
    const left = plan.find((p) => p.id === 'NS-L')!;
    assert.equal(left.status.get('N0L'), 'P');
    assert.equal(left.status.get('S0L'), 'P');
    assert.equal(left.status.has('N0T'), false, 'в левой фазе прямо — красный');
    const thr = plan.find((p) => p.id === 'NS-T')!;
    assert.equal(thr.status.has('N0L'), false, 'в прямой фазе налево — красный');
  });
  it('разворот без разрешения не попадает ни в одну фазу', () => {
    const plan = buildPlan('permissive', { N: true, E: false, S: false, W: false });
    const all = plan.flatMap((p) => [...p.status.keys()]);
    assert.ok(all.includes('N0U'));
    for (const d of DIRS.filter((d) => d !== 'N')) assert.ok(!all.includes(`${d}0U`));
  });
});
