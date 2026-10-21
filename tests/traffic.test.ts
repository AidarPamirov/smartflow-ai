import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CAR_LEN, Fleet, MIN_GAP, RIGHT_OFFSET } from '../src/traffic/fleet';
import { NETWORK_FORMAT, NetworkError, parseNetwork, type Network, type RawNetwork } from '../src/traffic/network';
import { CLASS_SPEED, RouteGenerator, buildRoute, shortestPath, type Route } from '../src/traffic/routing';

// ───────── маленький тестовый граф ─────────
// 3 × 3 узла через ~300 м; верхняя горизонталь — односторонняя на восток.
//   6 → 7 → 8
//   |   |   |
//   3 — 4 — 5
//   |   |   |
//   0 — 1 — 2
const d = 0.0037; // ≈ 300 м по долготе и ≈ 410 м по широте на 42,87°
const lon0 = 74.6, lat0 = 42.87;
function fixture(): Network {
  const nodes: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push(lon0 + c * d, lat0 + r * d);
  const E = (a: number, b: number, oneway = 0, mid: number[] = []): RawNetwork['edges'][number] => [a, b, 2, oneway, 0, 0, mid];
  const raw: RawNetwork = {
    format: NETWORK_FORMAT,
    meta: { title: 't', source: 't', osm_base: null, generated: '', license: '', attribution: '', bbox: [lon0 - 0.01, lat0 - 0.01, lon0 + 0.02, lat0 + 0.02], nodes: 9, edges: 0, km: 0 },
    classes: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'],
    names: [''],
    nodes,
    edges: [
      E(0, 1, 0, [lon0 + d / 2, lat0 + 0.0003]), E(1, 2), E(3, 4), E(4, 5), E(6, 7, 1), E(7, 8, 1),
      E(0, 3), E(3, 6), E(1, 4), E(4, 7), E(2, 5), E(5, 8),
    ],
  };
  return parseNetwork(raw);
}

const segKey = (x0: number, y0: number, x1: number, y1: number) => `${x0.toFixed(3)},${y0.toFixed(3)}>${x1.toFixed(3)},${y1.toFixed(3)}`;
/** Все отрезки сети в разрешённых направлениях. */
function allowedSegments(net: Network): Set<string> {
  const set = new Set<string>();
  for (const e of net.edges)
    for (let i = 1; i < e.xs.length; i++) {
      set.add(segKey(e.xs[i - 1], e.ys[i - 1], e.xs[i], e.ys[i]));
      if (!e.oneway) set.add(segKey(e.xs[i], e.ys[i], e.xs[i - 1], e.ys[i - 1]));
    }
  return set;
}
function assertRouteOnRoads(net: Network, r: Route, allowed: Set<string>) {
  assert.equal(r.xs.length, r.cum.length);
  for (let i = 1; i < r.xs.length; i++) {
    assert.ok(r.cum[i] > r.cum[i - 1] - 1e-9, 'длина растёт');
    assert.ok(allowed.has(segKey(r.xs[i - 1], r.ys[i - 1], r.xs[i], r.ys[i])), `отрезок ${i} маршрута не лежит на дороге сети или идёт против одностороннего движения`);
  }
  for (let i = 1; i < r.arcs.length; i++) {
    const prevEdge = net.edges[r.arcs[i - 1].edge];
    const end = r.arcs[i - 1].forward ? prevEdge.to : prevEdge.from;
    const e = net.edges[r.arcs[i].edge];
    assert.equal(r.arcs[i].forward ? e.from : e.to, end, 'дуги маршрута идут одна за другой');
  }
  for (const a of r.arcs) if (!a.forward) assert.ok(!net.edges[a.edge].oneway, 'проезд против одностороннего движения');
  const sum = r.arcs.reduce((acc, a) => acc + net.edges[a.edge].length, 0);
  assert.ok(Math.abs(sum - r.length) < 0.01, 'длина маршрута = сумма длин рёбер');
}

/** Расстояние от точки до отрезка. */
function distToSeg(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  return Math.hypot(px - x0 - dx * t, py - y0 - dy * t);
}

describe('сеть: загрузка и проверка', () => {
  it('битые файлы отклоняются с понятной ошибкой', () => {
    assert.throws(() => parseNetwork(null), NetworkError);
    assert.throws(() => parseNetwork({ format: 'x' }), /формат/);
    const raw = JSON.parse(readFileSync('public/data/bishkek-roads.json', 'utf8')) as RawNetwork;
    assert.throws(() => parseNetwork({ ...raw, edges: [[0, 999999, 0, 0, 0, 0, []]] }), /несуществующий узел/);
    assert.throws(() => parseNetwork({ ...raw, nodes: [10, 10, ...raw.nodes.slice(2)] }), /вне рамки/);
  });
});

describe('маршруты на тестовом графе', () => {
  const net = fixture();
  it('кратчайший путь учитывает одностороннее движение', () => {
    // 8 → 6 нельзя по верхней улице (она только на восток): путь идёт через средний ряд
    const p = shortestPath(net, 8, 6)!;
    assert.ok(p.length >= 3);
    for (const a of p) if (!a.forward) assert.ok(!net.edges[a.edge].oneway);
    const p2 = shortestPath(net, 6, 8)!;
    assert.equal(p2.length, 2, 'на восток — прямо по односторонней');
  });
  it('маршрут повторяет геометрию рёбер, включая изгибы', () => {
    const allowed = allowedSegments(net);
    const r = buildRoute(net, shortestPath(net, 0, 8)!, 0);
    assertRouteOnRoads(net, r, allowed);
    const bent = buildRoute(net, shortestPath(net, 2, 0)!, 2);
    assert.ok(bent.xs.length >= 4, 'промежуточная точка ребра 0–1 попала в маршрут');
  });
  it('скорость снижается перед поворотом на 90°', () => {
    const r = buildRoute(net, shortestPath(net, 0, 8)!, 0);
    const turns = [...r.vmax.slice(1, -1)].filter((v) => v < CLASS_SPEED.primary * 0.5);
    assert.ok(turns.length >= 1);
  });
});

describe('машины: дистанция и смещение', () => {
  const net = fixture();
  const r = buildRoute(net, shortestPath(net, 0, 2)!, 0); // прямая улица ≈ 600 м
  it('быстрая машина не обгоняет и не наезжает на медленную на той же улице', () => {
    const f = new Fleet([r], 1, 2, () => true);
    const [a, b] = f.vehicles;
    a.s = 60; a.v = 2; a.k = 0.2; // медленный лидер
    b.s = 10; b.v = 14; b.k = 1.05; // быстрый догоняющий
    a.seg = 0; b.seg = 0;
    let minGap = Infinity;
    for (let i = 0; i < 300; i++) {
      f.step(0.1);
      if (a.route !== r || b.route !== r) break; // кто-то доехал
      minGap = Math.min(minGap, a.s - b.s - CAR_LEN);
      assert.ok(b.s < a.s, 'обгон по той же полосе');
    }
    assert.ok(minGap >= MIN_GAP * 0.5 - 1e-6, `зазор упал до ${minGap.toFixed(2)} м`);
  });
  it('на двусторонней улице машина смещена вправо от оси', () => {
    const f = new Fleet([r], 1, 1, () => true);
    const p = f.pose(f.vehicles[0]);
    const off = distToSeg(p.x, p.y, r.xs[f.vehicles[0].seg], r.ys[f.vehicles[0].seg], r.xs[f.vehicles[0].seg + 1], r.ys[f.vehicles[0].seg + 1]);
    assert.ok(Math.abs(off - RIGHT_OFFSET) < 0.05);
    // едем на восток → правая сторона южнее оси
    assert.ok(p.y < r.ys[0]);
  });
});

describe('настоящая дорожная сеть Бишкека (OSM)', () => {
  const raw = JSON.parse(readFileSync('public/data/bishkek-roads.json', 'utf8'));
  const net = parseNetwork(raw);
  const allowed = allowedSegments(net);

  it('файл корректен, атрибуция OSM на месте, сеть сильно связна', () => {
    assert.match(net.meta.attribution, /OpenStreetMap/);
    assert.equal(net.meta.license, 'ODbL 1.0');
    assert.ok(net.nodeX.length > 500 && net.edges.length > 800, `${net.nodeX.length} узлов, ${net.edges.length} рёбер`);
    // из узла 0 достижимы все узлы, и в узел 0 можно попасть из всех
    const n = net.nodeX.length;
    const reach = (rev: boolean) => {
      const adj: number[][] = Array.from({ length: n }, () => []);
      net.out.forEach((arcs, u) => arcs.forEach((a) => (rev ? adj[a.to].push(u) : adj[u].push(a.to))));
      const seen = new Uint8Array(n); const st = [0]; seen[0] = 1; let c = 1;
      while (st.length) for (const w of adj[st.pop()!]) if (!seen[w]) { seen[w] = 1; c++; st.push(w); }
      return c;
    };
    assert.equal(reach(false), n);
    assert.equal(reach(true), n);
  });

  it('60 маршрутов: каждый отрезок лежит на дороге сети, без прямых через кварталы', () => {
    const gen = new RouteGenerator(net, 42);
    for (let i = 0; i < 60; i++) {
      const r = gen.next();
      assert.ok(r, `маршрут ${i} не построен`);
      assertRouteOnRoads(net, r!, allowed);
      assert.ok(r!.length >= 1500 * 0.9, 'поездка не короче ~1,5 км');
    }
  });

  it('400 машин, 10 минут: остаются на маршрутах, без NaN, не превышают скорость, продолжают поездки из точки прибытия', () => {
    const pool = (() => { const g = new RouteGenerator(net, 1); const out: Route[] = []; for (let i = 0; i < 80; i++) out.push(g.next()!); return out; })();
    const cont = new RouteGenerator(net, 2);
    let continued = 0, fromPool = 0;
    const f = new Fleet(pool, 3, 400, (r, a) => !net.edges[r.arcs[a].edge].oneway, (node) => {
      const r = cont.from(node);
      if (r) { assert.equal(r.from, node); continued++; } else fromPool++;
      return r;
    });
    const vMax = Math.max(...Object.values(CLASS_SPEED)) * 1.05 + 0.2;
    for (let t = 0; t < 600; t++) {
      f.step(1);
      if (t % 30) continue;
      for (const v of f.vehicles) {
        assert.ok(Number.isFinite(v.s) && Number.isFinite(v.v));
        assert.ok(v.s >= 0 && v.s <= v.route.length + 1e-6);
        assert.ok(v.v >= 0 && v.v <= vMax, `скорость ${v.v}`);
        const p = f.pose(v);
        const r = v.route;
        const dist = distToSeg(p.x, p.y, r.xs[v.seg], r.ys[v.seg], r.xs[v.seg + 1], r.ys[v.seg + 1]);
        assert.ok(dist <= RIGHT_OFFSET + 0.01, `машина ${v.id} в ${dist.toFixed(2)} м от своей дороги`);
      }
    }
    const s = f.stats();
    assert.ok(s.trips > 100, `завершено поездок: ${s.trips}`);
    assert.ok(s.meanSpeed > 3, 'машины не стоят');
    assert.ok(continued > fromPool * 10, 'новые поездки начинаются там, где закончились старые');
  });

  it('воспроизводимость и сброс: тот же seed — та же картина', () => {
    const mk = () => {
      const g = new RouteGenerator(net, 1); const pool: Route[] = []; for (let i = 0; i < 40; i++) pool.push(g.next()!);
      const cont = new RouteGenerator(net, 2);
      return new Fleet(pool, 5, 150, (r, a) => !net.edges[r.arcs[a].edge].oneway, (n) => cont.from(n));
    };
    const a = mk(), b = mk();
    const initial = a.vehicles.map((v) => a.pose(v));
    for (let i = 0; i < 120; i++) { a.step(1); b.step(1); }
    assert.deepEqual(a.vehicles.map((v) => a.pose(v)), b.vehicles.map((v) => b.pose(v)));
    a.reset();
    assert.deepEqual(a.vehicles.map((v) => a.pose(v)), initial, 'после сброса — начальная расстановка');
    assert.equal(a.stats().simTime, 0);
    assert.equal(a.stats().trips, 0);
  });

  it('изменение числа машин и пауза (шаг 0) не ломают состояние', () => {
    const g = new RouteGenerator(net, 9); const pool: Route[] = []; for (let i = 0; i < 20; i++) pool.push(g.next()!);
    const f = new Fleet(pool, 1, 100, () => true);
    const before = f.vehicles.map((v) => f.pose(v));
    f.step(0);
    assert.deepEqual(f.vehicles.map((v) => f.pose(v)), before);
    f.setCount(1000); assert.equal(f.vehicles.length, 1000);
    f.setCount(250); assert.equal(f.vehicles.length, 250);
    const t0 = performance.now(); f.setCount(1000); for (let i = 0; i < 50; i++) f.step(0.5); const ms = (performance.now() - t0) / 50;
    console.log(`  1000 машин: ${ms.toFixed(2)} мс на шаг 0,5 с`);
  });
});
