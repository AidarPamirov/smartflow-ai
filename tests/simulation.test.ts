import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signalConflict } from '../src/sim/conflicts';
import { DEFAULT_ADAPTIVE, DEFAULT_FIXED, type ControllerSpec } from '../src/sim/controllers';
import { runOnce, type Scenario } from '../src/sim/experiment';
import { STOP_S, headingAfter, type LaneUse } from '../src/sim/geometry';
import type { LeftMode } from '../src/sim/phases';
import { A_LAT, poseAt } from '../src/sim/routes';
import { DT, Simulation, type Flows, type TurnShares, type Turns } from '../src/sim/simulation';

const ALL_U = { N: true, E: true, S: true, W: true };
const same = (m: TurnShares): Turns => ({ N: { ...m }, E: { ...m }, S: { ...m }, W: { ...m } });
const MIX = same({ T: 60, L: 20, R: 15, U: 5 });
const flows: Flows = { N: 500, S: 500, E: 400, W: 400 };
const specs: ControllerSpec[] = [DEFAULT_FIXED, DEFAULT_ADAPTIVE];

function sim(over: Partial<ConstructorParameters<typeof Simulation>[0]> = {}) {
  return new Simulation({ seed: 1, flows: { ...flows }, controller: DEFAULT_FIXED, turns: MIX, uturn: { ...ALL_U }, ...over });
}

describe('безопасность: все режимы × контроллеры', () => {
  for (const leftMode of ['permissive', 'protected'] as LeftMode[])
    for (const laneUse of ['dedicated', 'shared'] as LaneUse[])
      for (const spec of specs)
        it(`${leftMode}/${laneUse}/${spec.kind}: нет общих зон, пересечений кузовов, проездов на красный, аварийных ограничений`, () => {
          for (const seed of [1, 2]) {
            const r = runOnce({ flows, turns: MIX, uturn: ALL_U, leftMode, laneUse }, seed, spec, 1200);
            const s = r.summary.safety;
            assert.equal(s.zoneViolations, 0, `две машины в общей конфликтной зоне (seed ${seed})`);
            assert.equal(s.overlaps, 0, `пересечение кузовов (seed ${seed})`);
            assert.equal(s.redViolations, 0, `проезд на красный (seed ${seed})`);
            assert.equal(s.interventions, 0, `аварийные ограничения (seed ${seed})`);
            assert.ok(s.minGap > 1.0, `минимальный зазор ${s.minGap.toFixed(2)} м (seed ${seed})`);
          }
        });
});

describe('красный сигнал', () => {
  it('на красном машины всех манёвров стоят до стоп-линии', () => {
    const s = sim({ flows: { N: 0, S: 0, E: 600, W: 600 }, controller: { kind: 'fixed', greenNS: 120, greenEW: 5, greenLeft: 5 } });
    s.run(100); // фаза С–Ю ещё зелёная (120 с), В–З красный
    const ew = s.allVehicles();
    assert.ok(ew.length > 0);
    assert.ok(new Set(ew.map((v) => v.man)).size >= 3, 'есть разные манёвры');
    for (const v of ew) assert.ok(v.s <= STOP_S + 1e-9, `${v.path.id} за стоп-линией: ${v.s}`);
    assert.equal(s.metrics.served, 0);
  });
});

describe('светофорные фазы во время симуляции', () => {
  for (const leftMode of ['permissive', 'protected'] as LeftMode[])
    it(`${leftMode}: на каждом шаге защищённые зелёные не конфликтуют, у уступающих есть приоритетный поток`, () => {
      const s = sim({ leftMode, controller: DEFAULT_ADAPTIVE });
      for (let i = 0; i < 6000; i++) {
        s.step();
        const g = [...s.currentPhase().status.keys()].filter((id) => s.lightOf(id) === 'G');
        for (let a = 0; a < g.length; a++)
          for (let b = a + 1; b < g.length; b++) assert.ok(!signalConflict(g[a], g[b]), `${g[a]} и ${g[b]} одновременно зелёные`);
      }
    });
});

describe('повороты и развороты', () => {
  it('каждый манёвр завершается: машина уезжает в нужную сторону', () => {
    const s = sim({ seed: 3 });
    const exitedHeading = new Map<number, number>();
    const trackers = new Map<number, { man: string; dir: string; maxBoxTime: number; enteredAt: number | null }>();
    let maxInBox = 0;
    for (let i = 0; i < 18000; i++) {
      s.step();
      for (const v of s.allVehicles()) {
        const tr = trackers.get(v.id) ?? { man: v.man, dir: v.dir, maxBoxTime: 0, enteredAt: null };
        if (v.crossed && tr.enteredAt === null) tr.enteredAt = s.t;
        if (tr.enteredAt !== null && v.s - v.len <= v.path.connEnd) maxInBox = Math.max(maxInBox, s.t - tr.enteredAt);
        trackers.set(v.id, tr);
        if (v.s > v.path.connEnd + 10 && !exitedHeading.has(v.id)) exitedHeading.set(v.id, poseAt(v.path, v.s).h);
        if (v.s > v.path.connEnd + 10) {
          const h = headingAfter(v.dir, v.man);
          assert.ok(Math.abs(Math.cos(poseAt(v.path, v.s).h) - h.x) < 1e-6 && Math.abs(Math.sin(poseAt(v.path, v.s).h) - h.y) < 1e-6);
        }
      }
    }
    const byMan = s.summary().byManeuver;
    for (const m of ['T', 'L', 'R', 'U'] as const) assert.ok(byMan[m].served > 0, `манёвр ${m} никто не завершил`);
    assert.ok(maxInBox < 30, `машина находилась внутри перекрёстка ${maxInBox.toFixed(1)} с`);
  });

  it('направление кузова меняется плавно: боковое ускорение ≤ 1,2 × допустимого', () => {
    const s = sim({ seed: 4 });
    const prev = new Map<number, number>();
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      s.step();
      for (const v of s.allVehicles()) {
        const h = poseAt(v.path, v.s - v.len / 2).h;
        const p = prev.get(v.id);
        if (p !== undefined) {
          let d = Math.abs(h - p); if (d > Math.PI) d = 2 * Math.PI - d;
          worst = Math.max(worst, (d / DT) * v.v); // ω·v = боковое ускорение
        }
        prev.set(v.id, h);
      }
    }
    assert.ok(worst <= 1.2 * A_LAT, `боковое ускорение ${worst.toFixed(2)} м/с²`);
  });

  it('запрещённый разворот не генерируется, даже если доля > 0', () => {
    const s = sim({ turns: same({ T: 50, L: 0, R: 0, U: 50 }), uturn: { N: false, E: false, S: false, W: false } });
    s.run(600);
    assert.equal(s.summary().byManeuver.U.served, 0);
    assert.ok(s.allVehicles().every((v) => v.man !== 'U'));
  });
});

describe('отсутствие взаимных блокировок', () => {
  for (const sc of [
    { leftMode: 'permissive', laneUse: 'shared' },
    { leftMode: 'protected', laneUse: 'dedicated' },
  ] as Scenario[])
    it(`${sc.leftMode}/${sc.laneUse}, высокая нагрузка 1 ч: каждые 10 мин обслуживается каждый манёвр`, () => {
      const s = sim({ flows: { N: 800, S: 800, E: 700, W: 700 }, leftMode: sc.leftMode, laneUse: sc.laneUse, controller: DEFAULT_ADAPTIVE });
      let prev = { T: 0, L: 0, R: 0, U: 0 } as Record<string, number>;
      for (let w = 0; w < 6; w++) {
        s.run(600);
        const by = s.summary().byManeuver;
        for (const m of ['T', 'L', 'R', 'U']) {
          const served = by[m as 'T'].served;
          assert.ok(served > prev[m], `окно ${w + 1}: манёвр ${m} не обслуживался 10 минут`);
          prev[m] = served;
        }
      }
    });
});

describe('воспроизводимость и метрики', () => {
  const sc: Scenario = { flows, turns: MIX, uturn: ALL_U, leftMode: 'permissive' };
  it('одинаковый seed → идентичный результат', () => {
    assert.deepEqual(runOnce(sc, 42, DEFAULT_ADAPTIVE, 600).summary, runOnce(sc, 42, DEFAULT_ADAPTIVE, 600).summary);
  });
  it('спрос одинаков для обоих контроллеров', () => {
    assert.equal(runOnce(sc, 7, DEFAULT_FIXED, 900).generated, runOnce(sc, 7, DEFAULT_ADAPTIVE, 900).generated);
  });
  it('сохранение машин и доли манёвров соответствуют заданным', () => {
    const s = sim({ seed: 9, turns: same({ T: 50, L: 25, R: 25, U: 0 }), flows: { N: 600, S: 600, E: 600, W: 600 } });
    s.run(3600);
    assert.equal(s.generated, s.metrics.served + s.inSystem());
    const g = s.generatedBy;
    assert.ok(Math.abs(g.L / s.generated - 0.25) < 0.03, `доля левых ${(g.L / s.generated).toFixed(3)}`);
    assert.ok(Math.abs(g.T / s.generated - 0.5) < 0.03, `доля прямых ${(g.T / s.generated).toFixed(3)}`);
    assert.equal(g.U, 0);
  });
  it('нулевой спрос: метрики пустые', () => {
    const r = runOnce({ flows: { N: 0, S: 0, E: 0, W: 0 } }, 1, DEFAULT_FIXED, 300);
    assert.equal(r.summary.served, 0);
    assert.equal(r.summary.avgWait, null);
    assert.equal(r.summary.byManeuver.L.avgWait, null);
  });
  it('только прямо: старое поведение сохранено (без конфликтов ожидание ≈ 0)', () => {
    const s = sim({ flows: { N: 300, S: 300, E: 0, W: 0 }, turns: same({ T: 100, L: 0, R: 0, U: 0 }), controller: DEFAULT_ADAPTIVE });
    s.run(900);
    assert.ok((s.metrics.avgWait ?? 1) < 0.2, `ожидание ${s.metrics.avgWait}`);
  });
});
