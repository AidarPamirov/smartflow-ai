#!/usr/bin/env node
/**
 * Выгрузка фактов о светофорах и пешеходных переходах центра Бишкека из OpenStreetMap (Overpass API).
 *
 *   node scripts/build-signals.mjs public/data/bishkek-signals-osm.json
 *
 * Только факты OSM, без выводов: узлы highway=traffic_signals, узлы-переходы (highway=crossing,
 * crossing=*) и их теги. Привязка к дорожному графу и «светофорные объекты» строятся в браузере
 * модулем src/signals/inventory.ts (он покрыт тестами), чтобы вывод можно было проверить и пересчитать.
 *
 * Рамка та же, что у дорожного графа (scripts/build-road-network.mjs).
 * Данные © OpenStreetMap contributors, лицензия ODbL 1.0.
 */
import { writeFileSync } from 'node:fs';

const BBOX = { south: 42.83, west: 74.54, north: 42.9, east: 74.68 };
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'SmartFlowAI-signals/1.0 (https://github.com/AidarPamirov/smartflow-ai)';
/** Теги, которые сохраняются (остальные не нужны модели). */
const KEEP = ['highway', 'crossing', 'crossing_ref', 'traffic_signals', 'traffic_signals:direction', 'direction', 'button_operated', 'traffic_signals:sound', 'crossing:island'];

const query = `[out:json][timeout:180][bbox:${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}];
(
  node["highway"="traffic_signals"];
  node["highway"="crossing"];
  node["crossing"="traffic_signals"];
);
out body qt;`;

async function fetchOverpass() {
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
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
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  throw new Error('Все серверы Overpass недоступны:\n' + errors.join('\n'));
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function buildSignals(osm, source) {
  const nodes = osm.elements
    .filter((e) => e.type === 'node')
    .map((e) => {
      const tags = {};
      for (const k of KEEP) if (e.tags?.[k] !== undefined) tags[k] = e.tags[k];
      return { id: e.id, lon: r6(e.lon), lat: r6(e.lat), tags };
    })
    .sort((a, b) => a.id - b.id);
  const signals = nodes.filter((n) => n.tags.highway === 'traffic_signals');
  const crossings = nodes.filter((n) => n.tags.highway !== 'traffic_signals');
  return {
    format: 'smartflow-osm-signals/1',
    meta: {
      title: 'Светофоры и пешеходные переходы центра Бишкека (факты OSM)',
      source: 'OpenStreetMap через Overpass API',
      endpoint: source,
      osm_base: osm.osm3s?.timestamp_osm_base ?? null,
      generated: new Date().toISOString(),
      license: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
      signals: signals.length,
      crossings: crossings.length,
      signalized_crossings: crossings.filter((n) => n.tags.crossing === 'traffic_signals').length,
    },
    signals,
    crossings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = process.argv[2] ?? 'public/data/bishkek-signals-osm.json';
  const { json, url } = await fetchOverpass();
  const out = buildSignals(json, url);
  writeFileSync(outPath, JSON.stringify(out));
  console.log(JSON.stringify(out.meta, null, 2));
}
