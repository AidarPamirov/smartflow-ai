#!/usr/bin/env node
/**
 * Выгрузка дорожного графа центра Бишкека из OpenStreetMap (Overpass API).
 *
 *   node scripts/build-road-network.mjs public/data/bishkek-roads.json
 *
 * Что делает:
 *  1. Запрашивает дороги категорий motorway…unclassified (без жилых улиц и проездов) в рамке BBOX.
 *  2. Делит линии OSM на рёбра в узлах-перекрёстках: узел, общий для нескольких линий, — это
 *     настоящий перекрёсток в данных OSM, а не догадка по геометрии.
 *  3. Учитывает oneway (yes/1/true/-1), кольца (junction=roundabout) и магистрали.
 *  4. Оставляет крупнейшую сильно связную компоненту: из любого узла можно доехать в любой.
 *
 * Данные © OpenStreetMap contributors, лицензия ODbL 1.0.
 */
import { writeFileSync } from 'node:fs';

export const BBOX = { south: 42.83, west: 74.54, north: 42.9, east: 74.68 };
export const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'];
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'SmartFlowAI-road-network/1.0 (https://github.com/AidarPamirov/smartflow-ai)';

const query = `[out:json][timeout:180][bbox:${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}];
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified)$"]["area"!="yes"]["access"!~"^(private|no)$"]["motor_vehicle"!~"^(private|no)$"];
(._;>;);
out body qt;`;

async function fetchOverpass() {
  const errors = [];
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements) || json.elements.length === 0) throw new Error('пустой ответ');
      return { json, url };
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
      console.error('Overpass недоступен:', url, e.message);
    }
  }
  throw new Error('Все серверы Overpass недоступны:\n' + errors.join('\n'));
}

const baseClass = (hw) => hw.replace(/_link$/, '');

/** Крупнейшая сильно связная компонента (итеративный алгоритм Косарайю). */
function largestScc(n, adj, radj) {
  const order = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const stack = [[s, 0]];
    seen[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i < adj[v].length) {
        top[1]++;
        const w = adj[v][i];
        if (!seen[w]) { seen[w] = 1; stack.push([w, 0]); }
      } else { order.push(v); stack.pop(); }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  let c = 0;
  const sizes = [];
  for (let k = n - 1; k >= 0; k--) {
    const s = order[k];
    if (comp[s] !== -1) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const v = stack.pop();
      size++;
      for (const w of radj[v]) if (comp[w] === -1) { comp[w] = c; stack.push(w); }
    }
    sizes.push(size);
    c++;
  }
  const best = sizes.indexOf(Math.max(...sizes));
  return { comp, best, sizes };
}

const R = 6371008.8;
function segLen(a, b) {
  const φ = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (b[0] - a[0]) * Math.PI / 180 * Math.cos(φ) * R;
  const dy = (b[1] - a[1]) * Math.PI / 180 * R;
  return Math.hypot(dx, dy);
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function buildNetwork(osm, source) {
  const coords = new Map();
  const ways = [];
  for (const el of osm.elements) {
    if (el.type === 'node') coords.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.push(el);
  }
  // 1. направление и пригодность линий
  const lines = [];
  for (const w of ways) {
    const t = w.tags ?? {};
    const hw = t.highway;
    if (!hw || !CLASSES.includes(baseClass(hw))) continue;
    if (t.oneway === 'reversible' || t.oneway === 'alternating') continue;
    let nodes = w.nodes.filter((id) => coords.has(id));
    if (nodes.length < 2) continue;
    let oneway = ['yes', '1', 'true'].includes(t.oneway) || t.junction === 'roundabout' || t.junction === 'circular' || hw === 'motorway' || hw === 'motorway_link';
    if (t.oneway === 'no') oneway = false;
    if (t.oneway === '-1') { nodes = [...nodes].reverse(); oneway = true; }
    const lanes = Number.parseInt(t.lanes ?? '', 10);
    lines.push({ id: w.id, nodes, cls: baseClass(hw), link: hw.endsWith('_link'), oneway, name: t['name:ru'] || t.name || '', lanes: Number.isFinite(lanes) ? lanes : 0 });
  }
  // 2. узлы-перекрёстки: используются несколько раз или являются концами линий
  const use = new Map();
  for (const l of lines) for (const id of l.nodes) use.set(id, (use.get(id) ?? 0) + 1);
  const isJ = (l, i) => i === 0 || i === l.nodes.length - 1 || use.get(l.nodes[i]) > 1;
  // 3. рёбра
  const jIndex = new Map();
  const jCoords = [];
  const jid = (osmId) => {
    let k = jIndex.get(osmId);
    if (k === undefined) { k = jCoords.length; jIndex.set(osmId, k); jCoords.push(coords.get(osmId)); }
    return k;
  };
  let edges = [];
  for (const l of lines) {
    let start = 0;
    for (let i = 1; i < l.nodes.length; i++) {
      if (!isJ(l, i)) continue;
      const seg = l.nodes.slice(start, i + 1).map((id) => coords.get(id));
      let len = 0;
      for (let k = 1; k < seg.length; k++) len += segLen(seg[k - 1], seg[k]);
      if (len >= 0.5 && l.nodes[start] !== l.nodes[i]) {
        edges.push({ from: jid(l.nodes[start]), to: jid(l.nodes[i]), cls: l.cls, oneway: l.oneway, name: l.name, lanes: l.lanes, len, mid: seg.slice(1, -1), way: l.id });
      }
      start = i;
    }
  }
  // 4. крупнейшая сильно связная компонента
  const n = jCoords.length;
  const adj = Array.from({ length: n }, () => []);
  const radj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.from].push(e.to); radj[e.to].push(e.from);
    if (!e.oneway) { adj[e.to].push(e.from); radj[e.from].push(e.to); }
  }
  const { comp, best, sizes } = largestScc(n, adj, radj);
  const keepNode = (k) => comp[k] === best;
  edges = edges.filter((e) => keepNode(e.from) && keepNode(e.to));
  const remap = new Int32Array(n).fill(-1);
  const nodesOut = [];
  for (let k = 0; k < n; k++) if (keepNode(k)) { remap[k] = nodesOut.length / 2; nodesOut.push(r6(jCoords[k][0]), r6(jCoords[k][1])); }

  const names = [''];
  const nameIdx = new Map([['', 0]]);
  const ni = (s) => { if (!nameIdx.has(s)) { nameIdx.set(s, names.length); names.push(s); } return nameIdx.get(s); };
  const km = edges.reduce((a, e) => a + e.len, 0) / 1000;
  const out = {
    format: 'smartflow-road-network/1',
    meta: {
      title: 'Дорожный граф центра Бишкека (магистрали и улицы до unclassified)',
      source: 'OpenStreetMap через Overpass API',
      endpoint: source,
      osm_base: osm.osm3s?.timestamp_osm_base ?? null,
      generated: new Date().toISOString(),
      license: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
      classes_included: CLASSES,
      nodes: nodesOut.length / 2,
      edges: edges.length,
      km: Math.round(km * 10) / 10,
      dropped_components: sizes.length - 1,
      dropped_nodes: n - nodesOut.length / 2,
    },
    classes: CLASSES,
    names,
    nodes: nodesOut,
    edges: edges.map((e) => [remap[e.from], remap[e.to], CLASSES.indexOf(e.cls), e.oneway ? 1 : 0, ni(e.name), e.lanes, e.mid.flatMap(([x, y]) => [r6(x), r6(y)])]),
  };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = process.argv[2] ?? 'public/data/bishkek-roads.json';
  const { json, url } = await fetchOverpass();
  const net = buildNetwork(json, url);
  writeFileSync(outPath, JSON.stringify(net));
  console.log(JSON.stringify(net.meta, null, 2));
}
