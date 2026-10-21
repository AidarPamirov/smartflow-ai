import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { crossPolyline, crossingTime, percentile, sectionSpeed, segmentIntersection, sideOf } from '../src/cameras/geometry';
import { pointOnArc, placeCameras } from '../src/cameras/placement';
import { CameraSystem, anonId, distToPolyline } from '../src/cameras/system';
import type { Camera } from '../src/cameras/types';
import { parseOsmSignals } from '../src/signals/inventory';
import { SignalSystem } from '../src/signals/system';
import { Fleet, type SignalHook, type Vehicle } from '../src/traffic/fleet';
import { NETWORK_FORMAT, parseNetwork, type RawNetwork } from '../src/traffic/network';
import { RouteGenerator, buildRoute } from '../src/traffic/routing';

describe('геометрия камер', () => {
  it('пересечение отрезков и сторона линии', () => {
    assert.deepEqual(segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0]), { t: 0.5, u: 0.5 });
    assert.equal(segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1]), null, 'параллельные');
    assert.equal(segmentIntersection([0, 0], [1, 0], [2, -1], [2, 1]), null, 'не дотянулся');
    assert.equal(sideOf([0, 0], [0, 10], [-1, 5]), 1);
    assert.equal(sideOf([0, 0], [0, 10], [1, 5]), -1);
  });
  it('пересечение ломаной: направление; касание без перехода — не пересечение', () => {
    const line: [number, number][] = [[0, 0], [0, 10], [0, 20]];
    assert.equal(crossPolyline([-1, 12], [1, 12], line)?.dir, 'left_to_right');
    assert.equal(crossPolyline([1, 3], [-1, 3], line)?.dir, 'right_to_left');
    assert.equal(crossPolyline([1, 3], [2, 4], line), null);
    assert.equal(crossPolyline([1, 3], [0, 3], line), null, 'доехал до линии, но не пересёк');
    assert.equal(crossPolyline([-1, 25], [1, 25], line), null, 'за концом линии');
  });
  it('время пересечения и скорость на участке не зависят от шага', () => {
    assert.equal(crossingTime(0, 10, 5, 100, 102), 101);
    assert.equal(crossingTime(0, 10, 10, 0, 1), 1);
    assert.equal(crossingTime(10, 20, 5, 0, 1), null, 'отметка уже позади');
    assert.equal(sectionSpeed(100, 10, 18), 12.5);
    assert.equal(sectionSpeed(100, 10, 10), null);
    assert.equal(sectionSpeed(0, 10, 12), null);
    assert.equal(percentile([], 0.85), null);
    assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
    assert.equal(distToPolyline([3, 5], [[0, 0], [0, 10]]), 3);
  });
});

// ───────── прямая улица 1000 м с востока на запад и обратно ─────────
const LON0 = 74.6, LAT0 = 42.87;
function street(): ReturnType<typeof parseNetwork> {
  const raw: RawNetwork = {
    format: NETWORK_FORMAT,
    meta: { title: 't', source: 't', osm_base: null, generated: '', license: '', attribution: '', bbox: [LON0 - 0.02, LAT0 - 0.02, LON0 + 0.03, LAT0 + 0.02], nodes: 2, edges: 1, km: 1 },
    classes: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'],
    names: ['', 'тестовая'],
    nodes: [LON0, LAT0, LON0 + 1000 / 81_600, LAT0],
    edges: [[0, 1, 2, 0, 1, 2, []]],
  };
  return parseNetwork(raw);
}

function cam(type: Camera['type'], marks: number[], extra: Partial<Camera> = {}): Camera {
  return {
    id: `cam-${type}`, type, lon: LON0, lat: LAT0, heading: 90, edge: 0, forward: true, marks, street: 'тестовая', signal: -1, limitKmh: 40,
    dataMode: type === 'seatbelt' ? 'mock' : 'synthetic',
    settings: { enabled: true, sensitivity: type === 'speed' ? 2 : type === 'line' ? 0.3 : 15, confidenceThreshold: 0.8 }, ...extra,
  };
}

/** Машины с постоянной скоростью — чтобы знать истинное значение. */
function drive(net: ReturnType<typeof street>, cams: Camera[], speeds: number[], dt: number, seconds: number, starts?: number[]) {
  const route = buildRoute(net, [{ edge: 0, forward: true, to: 1 }], 0);
  const vs: Vehicle[] = speeds.map((v, i) => ({ id: i + 1, route, s: starts?.[i] ?? 0, v, k: 1, seg: 0, arc: 0, wait: 0, stopKey: -1, stopD: Infinity, goArc: -1 }));
  const sys = new CameraSystem(net, cams);
  const pose = (v: Vehicle) => {
    const p = pointOnArc(net, 0, true, Math.min(v.s, route.length));
    return { id: v.id, x: p.x, y: p.y - 2.2, heading: 90, v: v.v };
  };
  for (let t = 0; t < seconds; t += dt) {
    for (const v of vs) v.s = Math.min(route.length - 0.01, v.s + v.v * dt);
    sys.process(vs, pose, dt);
  }
  return sys;
}

describe('камера скорости: время между двумя линиями', () => {
  const net = street();
  it('скорость равна истинной при любом шаге кадра', () => {
    for (const dt of [0.1, 0.7, 2.0]) {
      const sys = drive(net, [cam('speed', [450, 550])], [50 / 3.6], dt, 60);
      const m = sys.metrics(0);
      assert.equal(m.measured, 1, `dt=${dt}`);
      assert.ok(Math.abs(m.meanKmh! - 50) < 0.05, `dt=${dt}: ${m.meanKmh}`);
    }
  });
  it('превышение демонстрационного ограничения с допуском — предварительное событие', () => {
    const sys = drive(net, [cam('speed', [450, 550])], [50 / 3.6, 41 / 3.6], 0.5, 120);
    const ev = sys.events(0);
    assert.equal(ev.length, 1, '41 км/ч при ограничении 40 и допуске 2 — не нарушение');
    assert.equal(ev[0].kind, 'speeding');
    assert.ok(Math.abs(ev[0].value! - 50) < 0.1);
    assert.match(ev[0].vehicle!, /^v-[0-9a-f]{1,4}$/);
  });
  it('машина появилась внутри участка — скорость не определяется', () => {
    const sys = drive(net, [cam('speed', [450, 550])], [50 / 3.6], 0.5, 60, [500]);
    assert.equal(sys.metrics(0).measured, 0);
    assert.equal(sys.metrics(0).meanKmh, null);
  });
});

describe('камера потока', () => {
  const net = street();
  it('подсчёт и средняя скорость в момент пересечения', () => {
    const speeds = Array.from({ length: 10 }, (_, i) => (36 + i) / 3.6);
    const starts = speeds.map((_, i) => -i * 30);
    const sys = drive(net, [cam('flow', [400])], speeds, 0.5, 300, starts);
    const m = sys.metrics(0);
    assert.equal(m.passes, 10);
    assert.equal(m.flowVehH, Math.round((10 / 300) * 3600));
    assert.ok(Math.abs(m.meanSpeedKmh! - 40.5) < 0.1, String(m.meanSpeedKmh));
    assert.equal(m.queue, null, 'камера не у светофора и очереди не видит — показатель недоступен, а не 0');
  });
  it('нет машин — поток 0, скорость не выдумывается', () => {
    const sys = drive(net, [cam('flow', [400])], [], 0.5, 120);
    const m = sys.metrics(0);
    assert.equal(m.flowVehH, 0);
    assert.equal(m.meanSpeedKmh, null);
    assert.equal(sys.events(0).length, 0);
  });
});

describe('камера сплошной линии', () => {
  const net = street();
  it('машина у правого края линию не пересекает; выезд за ось — событие с направлением', () => {
    const c = cam('line', [600, 700]);
    const sys = new CameraSystem(net, [c]);
    const route = buildRoute(net, [{ edge: 0, forward: true, to: 1 }], 0);
    const v: Vehicle = { id: 7, route, s: 550, v: 10, k: 1, seg: 0, arc: 0, wait: 0, stopKey: -1, stopD: Infinity, goArc: -1 };
    let lateral = -2.2; // справа от оси (ось идёт на восток, справа — юг)
    const pose = (x: Vehicle) => { const p = pointOnArc(net, 0, true, x.s); return { id: x.id, x: p.x, y: p.y + lateral, heading: 90, v: x.v }; };
    for (let k = 0; k < 10; k++) { v.s += 5; sys.process([v], pose, 0.5); }
    assert.equal(sys.events(0).length, 0);
    for (let k = 0; k < 6; k++) { v.s += 5; lateral += 1.0; sys.process([v], pose, 0.5); }
    const ev = sys.events(0);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'line_crossing');
    assert.match(ev[0].text, /справа налево/);
  });
  it('касание глубже порога нет — «недостаточно данных», а не нарушение', () => {
    const c = cam('line', [600, 700], { settings: { enabled: true, sensitivity: 1.0, confidenceThreshold: 0.8 } });
    const sys = new CameraSystem(net, [c]);
    const route = buildRoute(net, [{ edge: 0, forward: true, to: 1 }], 0);
    const v: Vehicle = { id: 8, route, s: 620, v: 10, k: 1, seg: 0, arc: 0, wait: 0, stopKey: -1, stopD: Infinity, goArc: -1 };
    let lateral = -0.2;
    const pose = (x: Vehicle) => { const p = pointOnArc(net, 0, true, x.s); return { id: x.id, x: p.x, y: p.y + lateral, heading: 90, v: x.v }; };
    sys.process([v], pose, 0.5);
    v.s += 5; lateral = 0.3;
    sys.process([v], pose, 0.5);
    const ev = sys.events(0);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'insufficient_data');
  });
});

describe('ремень и отсутствие данных', () => {
  const net = street();
  it('камера ремня — макет: нет источника, нет оценок, нет событий', () => {
    const sys = drive(net, [cam('seatbelt', [400])], [10], 0.5, 120);
    assert.equal(sys.status(0), 'offline');
    assert.equal(sys.events(0).length, 0);
    const m = sys.metrics(0);
    assert.equal(m.flowVehH, null);
    assert.equal(m.meanKmh, null);
  });
  it('до появления трафика камера «нет данных», метрики недоступны', () => {
    const sys = new CameraSystem(net, [cam('flow', [400])]);
    assert.equal(sys.status(0), 'no_data');
    const m = sys.metrics(0);
    for (const k of ['flowVehH', 'meanSpeedKmh', 'densityVehKm', 'occupancy', 'queue'] as const) assert.equal(m[k], null, k);
  });
  it('выключенная камера ничего не считает', () => {
    const c = cam('flow', [400]);
    c.settings.enabled = false;
    const sys = drive(net, [c], [10], 0.5, 120);
    assert.equal(sys.status(0), 'offline');
    assert.equal(sys.metrics(0).passes, 0);
  });
  it('анонимные номера не совпадают с id и стабильны', () => {
    assert.equal(anonId(5), anonId(5));
    assert.notEqual(anonId(5), anonId(6));
    assert.ok(!anonId(123).includes('123'));
  });
});

describe('реальные данные: камеры центра Бишкека', () => {
  const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/bishkek-roads.json', import.meta.url), 'utf8')));
  const osm = parseOsmSignals(JSON.parse(readFileSync(new URL('../public/data/bishkek-signals-osm.json', import.meta.url), 'utf8')));
  const sig = new SignalSystem(net, osm);
  const cams = placeCameras(net, sig);

  it('расстановка: все типы, ID уникальны, отметки внутри участков, режим данных честный', () => {
    const by = (t: Camera['type']) => cams.filter((c) => c.type === t).length;
    for (const t of ['flow', 'speed', 'line', 'seatbelt'] as const) assert.ok(by(t) > 0, t);
    assert.equal(new Set(cams.map((c) => c.id)).size, cams.length);
    for (const c of cams) {
      const len = net.edges[c.edge].length;
      for (const m of c.marks) assert.ok(m >= 0 && m <= len, `${c.id}: ${m} из ${len}`);
      assert.ok(['synthetic', 'mock'].includes(c.dataMode), `${c.id}: ${c.dataMode}`);
      if (c.type === 'line') assert.equal(net.edges[c.edge].oneway, false, 'ось дороги — только у двусторонних');
      if (c.type === 'seatbelt') assert.equal(c.dataMode, 'mock');
    }
  });

  it('10 минут трафика со светофорами: скорости правдоподобны, линию никто не пересёк, всё анонимно', () => {
    const gen = new RouteGenerator(net, 2026);
    const pool = Array.from({ length: 120 }, () => gen.next()!);
    const cont = new RouteGenerator(net, 2027);
    const hook: SignalHook = { controlled: (k) => sig.byArc.has(k), light: (k) => sig.lightForArc(k) };
    const fleet = new Fleet(pool, 2026, 800, (r, a) => !net.edges[r.arcs[a].edge].oneway, (n) => cont.from(n), hook);
    const sys = new CameraSystem(net, cams);
    for (let k = 0; k < 1200; k++) {
      fleet.step(0.5);
      const obs = fleet.approachObs();
      sig.step(0.5);
      sys.process(fleet.vehicles, (v) => fleet.pose(v), 0.5, obs);
    }
    let passes = 0, measured = 0;
    cams.forEach((c, i) => {
      const m = sys.metrics(i, fleet.approachObs());
      passes += m.passes;
      measured += m.measured;
      if (m.maxKmh !== null) assert.ok(m.maxKmh <= 60 * 1.05 + 0.5, `${c.id}: ${m.maxKmh} км/ч быстрее модели`);
      if (m.meanSpeedKmh !== null) assert.ok(m.meanSpeedKmh >= 0 && m.meanSpeedKmh < 70);
      for (const e of sys.events(i)) if (e.vehicle) assert.match(e.vehicle, /^v-[0-9a-f]{1,4}$/);
      if (c.type === 'line') assert.equal(sys.metrics(i).crossings, 0, 'в демо-трафике машины держатся правее оси');
    });
    assert.ok(passes > 100, `проездов мимо камер ${passes}`);
    assert.ok(measured > 5, `замеров скорости ${measured}`);
  });
});
