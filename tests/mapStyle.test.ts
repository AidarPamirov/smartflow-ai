import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BISHKEK, DEFAULT_BUILDING_HEIGHT, buildStyle, buildingVisibility } from '../src/map/style';

const style = buildStyle();
const layers = style.layers as { id: string; type: string; 'source-layer'?: string; paint?: Record<string, unknown> }[];

describe('стиль карты Бишкека', () => {
  it('единственный источник — тайлы OpenFreeMap с атрибуцией OpenMapTiles и OpenStreetMap', () => {
    const sources = Object.values(style.sources) as { url?: string; attribution?: string }[];
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'https://tiles.openfreemap.org/planet');
    assert.match(sources[0].attribution ?? '', /OpenMapTiles/);
    assert.match(sources[0].attribution ?? '', /openstreetmap\.org\/copyright/);
  });

  it('нет слоёв с компаниями, заведениями и номерами домов', () => {
    const used = new Set(layers.map((l) => l['source-layer']).filter(Boolean));
    for (const banned of ['poi', 'housenumber', 'aerodrome_label']) assert.ok(!used.has(banned), `используется слой ${banned}`);
  });

  it('высота зданий берётся из данных тайла, без своих выдуманных значений', () => {
    const b = layers.find((l) => l.id === 'building-3d');
    assert.ok(b && b.type === 'fill-extrusion');
    const h = JSON.stringify(b.paint?.['fill-extrusion-height']);
    assert.match(h, /render_height/);
    // Запасное значение совпадает с тем, что ставит генератор тайлов, и низкое.
    assert.ok(h.includes(String(DEFAULT_BUILDING_HEIGHT)));
    assert.ok(DEFAULT_BUILDING_HEIGHT <= 5);
    assert.match(JSON.stringify(b.paint?.['fill-extrusion-base']), /render_min_height/);
  });

  it('есть дороги, вода и здания; уникальные id слоёв', () => {
    const ids = layers.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['road-primary', 'road-minor', 'water', 'building-3d', 'building-flat']) assert.ok(ids.includes(id), id);
  });

  it('режимы: 3D — объёмные здания, план — плоские контуры', () => {
    assert.deepEqual(buildingVisibility('3d'), { flat: 'none', extruded: 'visible' });
    assert.deepEqual(buildingVisibility('2d'), { flat: 'visible', extruded: 'none' });
  });

  it('стартовый вид — центр Бишкека внутри ограничивающей рамки', () => {
    const [[w, s], [e, n]] = BISHKEK.maxBounds;
    const [lng, lat] = BISHKEK.center;
    assert.ok(lng > w && lng < e && lat > s && lat < n);
    assert.ok(Math.abs(lat - 42.876) < 0.01 && Math.abs(lng - 74.604) < 0.01, 'площадь Ала-Тоо');
  });
});
