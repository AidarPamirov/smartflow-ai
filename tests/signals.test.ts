import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ALL_RED, YELLOW, initialSignal, stepSignal } from '../src/sim/signalMachine';
import {
  ASSIGN_M, MAX_DIAMETER_M, OSM_SIGNALS_FORMAT, SignalDataError, angleDiff, bearingOf, buildInventory, parseOsmSignals,
  type OsmNode, type RawOsmSignals,
} from '../src/signals/inventory';
import { LOST_PER_PHASE, MAX_GREEN, MIN_GREEN, PED_GREEN, fixedStateAt, fixedTiming, offsetOf, phaseGroups } from '../src/signals/plan';
import { HARD_MAX_GREEN, MIN_GREEN_SAFE, SignalRuntime, type ControlMode } from '../src/signals/runtime';
import { SignalSystem, arcKey } from '../src/signals/system';
import { NETWORK_FORMAT, parseNetwork, toLonLat, type Network, type RawNetwork } from '../src/traffic/network';
import { mulberry32 } from '../src/sim/rng';

// ───────── тестовый город ─────────
// Перекрёсток X (узел 0) — 4 подхода по 300 м, с востока одностороннее движение К перекрёстку.
// Перекрёсток Y с разделёнными проезжими частями: узлы 5 и 6 в 20 м друг от друга (связаны коротким участком),
// к ним 4 подхода. Перекрёсток Z (узел 11) — без светофора в OSM.
const LON0 = 74.6, LAT0 = 42.87;
const mx = 1 / 81_600, my = 1 / 111_200; // градусов на метр
const P = (x: number, y: number) => [LON0 + x * mx, LAT0 + y * my];

function city(): { net: Network; osm: RawOsmSignals } {
  const pts: [number, number][] = [
    [0, 0], [0, 300], [300, 0], [0, -300], [-300, 0], // X и концы подходов: 1 север, 2 восток, 3 юг, 4 запад
    [1000, 0], [1000, 20], [1000, 320], [1300, 10], [1000, -300], [700, 10], // Y: 5, 6; 7 север, 8 восток, 9 юг, 10 запад
    [2000, 0], [2000, 300], [2300, 0], [2000, -300], // Z: 11 и концы
  ];
  const nodes = pts.flatMap(([x, y]) => P(x, y));
  const E = (a: number, b: number, oneway = 0, cls = 2, lanes = 0): RawNetwork['edges'][number] => [a, b, cls, oneway, 0, lanes, []];
  const raw: RawNetwork = {
    format: NETWORK_FORMAT,
    meta: { title: 't', source: 't', osm_base: null, generated: '', license: '', attribution: '', bbox: [LON0 - 0.02, LAT0 - 0.02, LON0 + 0.05, LAT0 + 0.02], nodes: pts.length, edges: 0, km: 0 },
    classes: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'],
    names: [''],
    nodes,
    edges: [
      E(0, 1, 0, 3, 2), E(2, 0, 1, 2, 3), E(0, 3, 0, 3, 2), E(0, 4, 0, 2, 4), // X: восток — односторонний к центру
      E(5, 6), E(6, 7), E(5, 9), E(6, 8, 0, 2), E(5, 10, 0, 2), E(5, 8), // Y: 5–6 короткий; 5–8 и 6–8 — две проезжие части на восток
      E(11, 12), E(11, 13), E(11, 14), E(2, 13), E(8, 11), E(4, 1), E(3, 9),
    ],
  };
  const net = parseNetwork(raw);
  const node = (id: number, x: number, y: number, tags: Record<string, string>): OsmNode => {
    const [lon, lat] = P(x, y);
    return { id, lon, lat, tags };
  };
  const osm: RawOsmSignals = {
    format: OSM_SIGNALS_FORMAT,
    meta: { osm_base: null, generated: '', attribution: '', license: '', bbox: raw.meta.bbox, signals: 5, crossings: 2 },
    signals: [
      node(101, 0, 15, { highway: 'traffic_signals' }), // X, 15 м к северу
      node(102, 1000, -18, { highway: 'traffic_signals' }), // Y, у узла 5
      node(103, 1000, 38, { highway: 'traffic_signals' }), // Y, у узла 6
      node(104, 500, 200, { highway: 'traffic_signals', crossing: 'traffic_signals' }), // пешеходный, далеко от развилок
      node(105, -150, 150, { highway: 'traffic_signals' }), // вне графа
    ],
    crossings: [node(201, 0, -20, { highway: 'crossing', crossing: 'traffic_signals' }), node(202, 1000, 50, { highway: 'crossing', crossing: 'zebra' })],
  };
  return { net, osm };
}

describe('факты OSM о светофорах', () => {
  it('файл проверяется', () => {
    assert.throws(() => parseOsmSignals(null), SignalDataError);
    assert.throws(() => parseOsmSignals({ format: 'x', meta: {}, signals: [], crossings: [] }), SignalDataError);
    assert.throws(() => parseOsmSignals({ format: OSM_SIGNALS_FORMAT, meta: {}, signals: [{ id: 1, lon: 'a', lat: 2, tags: {} }], crossings: [] }), SignalDataError);
    assert.doesNotThrow(() => parseOsmSignals(city().osm));
  });
  it('азимуты', () => {
    assert.equal(bearingOf(0, 1), 0);
    assert.equal(bearingOf(1, 0), 90);
    assert.equal(bearingOf(-1, 0), 270);
    assert.equal(angleDiff(350, 10), 20);
  });
});

describe('светофорные объекты из OSM', () => {
  const { net, osm } = city();
  const inv = buildInventory(net, osm);
  const byId = new Map(inv.sites.map((s) => [s.id, s]));

  it('объекты только там, где в OSM есть светофор', () => {
    assert.deepEqual(inv.sites.map((s) => s.id).sort(), ['tls-101', 'tls-102']);
    assert.ok(!inv.sites.some((s) => s.nodes.includes(11)), 'перекрёсток Z без светофора в OSM не регулируется');
    assert.equal(inv.stats.assigned + inv.stats.standalone, osm.signals.length);
  });

  it('пешеходный светофор и светофор вне графа — отдельно', () => {
    const r = Object.fromEntries(inv.standalone.map((s) => [s.osm, s.reason]));
    assert.deepEqual(r, { 104: 'pedestrian', 105: 'off_graph' });
  });

  it('разделённые проезжие части — один объект', () => {
    const y = byId.get('tls-102')!;
    assert.deepEqual(y.nodes, [5, 6]);
    assert.deepEqual(y.osmSignals, [102, 103]);
    assert.ok(y.diameter < MAX_DIAMETER_M);
    assert.equal(y.legs.length, 4, 'две проезжие части на восток — один подход');
    const east = y.legs.find((l) => angleDiff(l.bearing, 90) < 20)!;
    assert.equal(east.inbound.length, 2);
    assert.equal(y.crossings.total, 1);
  });

  it('подходы, направления и полосы', () => {
    const x = byId.get('tls-101')!;
    assert.equal(x.status, 'ok');
    assert.equal(x.legs.length, 4);
    for (const [b, ins, outs] of [[0, 1, 1], [90, 1, 0], [180, 1, 1], [270, 1, 1]] as const) {
      const l = x.legs.find((q) => angleDiff(q.bearing, b) < 5)!;
      assert.ok(l, `подход ${b}°`);
      assert.equal(l.inbound.length, ins, `въезд ${b}°`);
      assert.equal(l.outbound.length, outs, `выезд ${b}°: восток — односторонний к центру`);
    }
    const east = x.legs.find((q) => angleDiff(q.bearing, 90) < 5)!;
    assert.equal(east.lanesIn, 3);
    const west = x.legs.find((q) => angleDiff(q.bearing, 270) < 5)!;
    assert.equal(west.lanesIn, 2, 'двусторонняя улица на 4 полосы → 2 на въезд');
    assert.equal(x.crossings.signalized, 1);
  });

  it('светофор дальше ASSIGN_M от развилки к ней не относится', () => {
    const far = structuredClone(osm);
    far.signals = [{ ...far.signals[0], lat: LAT0 + (ASSIGN_M + 5) * my }];
    const inv2 = buildInventory(net, far);
    assert.equal(inv2.sites.length, 0);
    assert.equal(inv2.standalone.length, 1);
  });
});

describe('виртуальный план фаз', () => {
  const { net, osm } = city();
  const inv = buildInventory(net, osm);
  const x = inv.sites.find((s) => s.id === 'tls-101')!;

  it('противоположные подходы — в одной фазе, главная дорога первой', () => {
    const g = phaseGroups(x);
    assert.equal(g.length, 2);
    const axes = g.map((q) => q.legs.map((i) => Math.round(x.legs[i].bearing)).sort((a, b) => a - b));
    assert.deepEqual(axes, [[90, 270], [0, 180]], 'класс secondary (В–З) старше tertiary (С–Ю)');
    const all = g.flatMap((q) => q.legs);
    assert.equal(new Set(all).size, all.length, 'подход не может быть в двух фазах');
  });

  it('одна фаза по геометрии → добавляется пешеходная', () => {
    const t = structuredClone(x);
    t.legs = t.legs.filter((l) => angleDiff(l.bearing, 90) < 5 || angleDiff(l.bearing, 270) < 5);
    const g = phaseGroups(t);
    assert.equal(g.length, 2);
    assert.ok(g[1].pedestrian && g[1].legs.length === 0);
    assert.equal(fixedTiming(t, g).greens[1], PED_GREEN);
  });

  it('Т-образный перекрёсток — две фазы', () => {
    const t = structuredClone(x);
    t.legs = t.legs.filter((l) => angleDiff(l.bearing, 0) > 5);
    assert.equal(phaseGroups(t).length, 2);
  });

  it('зелёные в пределах, цикл = зелёные + переходы, сдвиг детерминирован', () => {
    const g = phaseGroups(x);
    const tm = fixedTiming(x, g);
    for (const v of tm.greens) assert.ok(v >= MIN_GREEN && v <= MAX_GREEN && Number.isInteger(v));
    assert.equal(tm.cycle, tm.greens.reduce((a, b) => a + b, 0) + LOST_PER_PHASE * g.length);
    assert.equal(tm.offset, offsetOf(x.id, tm.cycle));
    assert.ok(tm.offset >= 0 && tm.offset < tm.cycle);
    assert.ok(tm.greens[0] >= tm.greens[1], 'главной дороге — не меньше зелёного');
  });

  it('аналитическое положение плана совпадает с работой автомата', () => {
    const g = phaseGroups(x);
    const tm = fixedTiming(x, g);
    const rt = new SignalRuntime(g, tm, 0);
    for (let k = 0; k < 3000; k++) {
      rt.step(0.5);
      const p = fixedStateAt(tm, (k + 1) * 0.5);
      assert.equal(rt.state.stage, p.stage, `t=${(k + 1) * 0.5}`);
      assert.equal(rt.state.phase, p.phase);
    }
  });
});

describe('работа светофора: безопасность и режимы', () => {
  const { net, osm } = city();
  const x = buildInventory(net, osm).sites.find((s) => s.id === 'tls-101')!;
  const g = phaseGroups(x);
  const tm = fixedTiming(x, g);

  /** Проверяет историю: зелёный одной фазе, жёлтый ровно 3 с, «все красные» ровно 2 с, зелёный 8…120 с. */
  function audit(rt: SignalRuntime, steps: number, dt: number, each: (k: number) => void) {
    let last = { stage: rt.state.stage, phase: rt.state.phase, since: 0 };
    let t = 0;
    let first = true;
    for (let k = 0; k < steps; k++) {
      each(k);
      rt.step(dt, () => g.map(() => ({ queue: 0, approaching: 0, maxWait: 0 })));
      t += dt;
      const lights = g.map((_, i) => rt.light(i));
      assert.ok(lights.filter((l) => l === 'G' || l === 'Y').length <= 1, `t=${t}: зелёный/жёлтый у двух фаз`);
      const s = rt.state;
      if (s.stage !== last.stage || s.phase !== last.phase) {
        const dur = t - last.since;
        if (!first) {
          if (last.stage === 'green') { assert.equal(s.stage, 'yellow'); assert.ok(dur >= MIN_GREEN_SAFE - 1e-6 && dur <= HARD_MAX_GREEN + dt, `зелёный ${dur}`); }
          if (last.stage === 'yellow') { assert.equal(s.stage, 'allred'); assert.ok(Math.abs(dur - YELLOW) <= dt + 1e-6, `жёлтый ${dur}`); }
          if (last.stage === 'allred') { assert.equal(s.stage, 'green'); assert.ok(Math.abs(dur - ALL_RED) <= dt + 1e-6, `все красные ${dur}`); }
        }
        first = false;
        last = { stage: s.stage, phase: s.phase, since: t };
      }
    }
  }

  it('случайная смена режимов и ручные команды: 2 ч без нарушений', () => {
    const rnd = mulberry32(7);
    const rt = new SignalRuntime(g, tm, 0);
    const modes: ControlMode[] = ['fixed', 'adaptive', 'manual'];
    audit(rt, 36000, 0.2, () => {
      const u = rnd();
      if (u < 0.002) rt.setMode(modes[Math.floor(rnd() * 3)]);
      else if (u < 0.006) rt.requestPhase(Math.floor(rnd() * g.length));
    });
  });

  it('ручной режим держит фазу до команды, но не дольше жёсткого максимума', () => {
    const rt = new SignalRuntime(g, tm, 0);
    for (let k = 0; k < 100 && rt.state.stage !== 'green'; k++) rt.step(0.5);
    rt.setMode('manual');
    const ph = rt.state.phase;
    const el0 = rt.state.elapsed;
    for (let k = 0; k < (HARD_MAX_GREEN - el0 - 1) * 2; k++) rt.step(0.5);
    assert.equal(rt.state.stage, 'green');
    assert.equal(rt.state.phase, ph);
    for (let k = 0; k < 4; k++) rt.step(0.5);
    assert.equal(rt.state.stage, 'yellow', 'после 120 с зелёный сменяется даже в ручном режиме');
    assert.match(rt.log.at(-1)!.reason, /жёсткий максимум/);
  });

  it('ошибка адаптивного контроллера → фиксированный план и запись в журнале', () => {
    const rt = new SignalRuntime(g, tm, 0);
    rt.setMode('adaptive');
    for (let k = 0; k < 400; k++) rt.step(0.5, () => [{ queue: -1, approaching: 0, maxWait: 0 }]);
    assert.equal(rt.mode, 'fixed');
    assert.ok(rt.log.some((d) => /ошибка адаптивного контроллера/.test(d.reason)));
    audit(rt, 2000, 0.5, () => undefined);
  });

  it('адаптивный: нет машин — зелёный не дёргается; очередь на красной фазе — переключение с причиной', () => {
    const rt = new SignalRuntime(g, tm, 0);
    // ждём начала нового зелёного, чтобы не упереться в максимум
    for (let k = 0; k < 400 && !(rt.state.stage === 'green' && rt.state.elapsed < 0.6); k++) rt.step(0.5);
    rt.setMode('adaptive');
    const ph = rt.state.phase;
    for (let k = 0; k < 20; k++) rt.step(0.5, () => g.map(() => ({ queue: 0, approaching: 0, maxWait: 0 })));
    assert.equal(rt.state.phase, ph, 'никого нет — фаза не меняется');
    const other = (ph + 1) % g.length;
    for (let k = 0; k < 40 && rt.state.stage === 'green'; k++)
      rt.step(0.5, () => g.map((_, i) => (i === other ? { queue: 6, approaching: 2, maxWait: 40 } : { queue: 0, approaching: 0, maxWait: 0 })));
    assert.equal(rt.state.stage, 'yellow');
    assert.equal(rt.state.next, other);
    assert.match(rt.log.at(-1)!.reason, /разрыв потока/);
  });

  it('выключенный светофор не горит', () => {
    const rt = new SignalRuntime(g, tm, 0);
    rt.setStatus('inactive');
    assert.deepEqual(g.map((_, i) => rt.light(i)), g.map(() => 'off'));
    assert.equal(rt.timeToSwitch(), null);
  });

  it('общий автомат: жёлтый и «все красные» не пропускаются', () => {
    const s = initialSignal(0);
    stepSignal(s, 10, () => 1);
    assert.equal(s.stage, 'yellow');
    stepSignal(s, 1, () => 0);
    assert.equal(s.stage, 'yellow');
    stepSignal(s, 2, () => 0);
    assert.equal(s.stage, 'allred');
    stepSignal(s, 2, () => 0);
    assert.deepEqual([s.stage, s.phase], ['green', 1]);
  });
});

describe('реальные данные: светофоры центра Бишкека', () => {
  const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/bishkek-roads.json', import.meta.url), 'utf8')));
  const osm = parseOsmSignals(JSON.parse(readFileSync(new URL('../public/data/bishkek-signals-osm.json', import.meta.url), 'utf8')));
  const sys = new SignalSystem(net, osm);
  const inv = sys.inv;

  it('каждый светофор OSM учтён: в объекте или отдельно', () => {
    assert.equal(inv.stats.assigned + inv.stats.standalone, osm.signals.length);
    const all = [...inv.sites.flatMap((s) => s.osmSignals), ...inv.standalone.map((s) => s.osm)];
    assert.equal(new Set(all).size, osm.signals.length);
    assert.ok(inv.sites.length >= 150, `объектов ${inv.sites.length}`);
  });

  it('объекты компактные, у рабочих — не меньше двух фаз, подход не в двух фазах', () => {
    for (const it of sys.items) {
      if (it.site.status === 'ok') {
        assert.ok(it.site.diameter <= MAX_DIAMETER_M, it.site.id);
        assert.ok(it.groups.length >= 2, `${it.site.id}: фаз ${it.groups.length}`);
        const legs = it.groups.flatMap((q) => q.legs);
        assert.equal(new Set(legs).size, legs.length, it.site.id);
      } else assert.equal(it.rt, null);
    }
  });

  it('Чуй × Манаса — один объект с 4 светофорами OSM и 4 подходами, связан с зоной SUMO', () => {
    const it = sys.items.find((q) => q.zone?.id === 'chui-manas')!;
    assert.ok(it, 'зона SUMO привязана к светофору');
    assert.deepEqual(it.site.osmSignals, [244504528, 815739971, 13390199065, 13390199067]);
    assert.equal(it.site.legs.length, 4);
  });

  it('въездной участок принадлежит одному светофору; сигнал по участку = сигнал подхода', () => {
    let n = 0;
    for (const it of sys.items) it.site.legs.forEach((leg, li) => {
      if (it.legGroup[li] < 0 || !it.rt) return;
      for (const d of leg.inbound) {
        const r = sys.byArc.get(arcKey(d.edge, d.forward))!;
        if (r.item !== it.index) continue; // участок между двумя соседними светофорами — у ближайшего по построению
        assert.equal(sys.lightForArc(arcKey(d.edge, d.forward)), sys.legLight(it, li));
        n++;
      }
    });
    assert.ok(n > 300);
  });

  it('час работы всех светофоров: ни у одного нет двух зелёных фаз', () => {
    for (let k = 0; k < 1800; k++) {
      sys.step(2);
      for (const it of sys.items) {
        if (!it.rt) continue;
        const on = it.groups.filter((_, i) => ['G', 'Y'].includes(it.rt!.light(i))).length;
        assert.ok(on <= 1, it.site.id);
      }
    }
  });

  it('координаты объектов внутри рамки графа', () => {
    const [w, s, e, n] = net.meta.bbox;
    for (const it of sys.items) {
      const [lon, lat] = toLonLat(net.proj, it.site.x, it.site.y);
      assert.ok(Math.abs(lon - it.site.lon) < 1e-5 && Math.abs(lat - it.site.lat) < 1e-5);
      assert.ok(lon > w - 0.01 && lon < e + 0.01 && lat > s - 0.01 && lat < n + 0.01);
    }
  });
});
