import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseCv, validateCv } from '../src/cv/cvResults';

const DIR = new URL('../public/data/cv/', import.meta.url);

describe('результаты компьютерного зрения (public/data/cv)', () => {
  const data = parseCv(JSON.parse(readFileSync(new URL('cv-results.json', DIR), 'utf8')));
  const row = (c: string) => data.summary.find((r) => r.condition === c);

  it('формат, все условия съёмки, картинки на месте', () => {
    assert.deepEqual(validateCv(data), []);
    for (const c of ['clear', 'noisy', 'lowres', 'dropout', 'uncalibrated']) assert.ok(row(c), c);
    assert.ok(data.images.length >= 3);
    for (const im of data.images) assert.ok(existsSync(new URL(im.file, DIR)), im.file);
  });

  it('без калибровки нет выдуманных чисел: скорость, линия и очередь — «нет данных»', () => {
    const r = row('uncalibrated')!;
    assert.equal(r.module_status.speed_estimation, 'no_calibration');
    assert.equal(r.module_status.lane_crossing_detection, 'no_calibration');
    for (const k of ['speed_mae_kmh', 'speed_p95_abs_err_kmh', 'queue_mae_m', 'density_count_mae'] as const) assert.equal(r[k][0], null, k);
    assert.equal(r.count_est, null);
    assert.equal(r.speeding_true, null, 'превышения без калибровки не ищутся — не «0 найдено»');
    assert.equal(r.solid_true, null);
    assert.ok(r.detection_recall_pct[0]! > 0, 'детекция без калибровки работает');
  });

  it('ремень: модели нет — модуль не проверен и никогда не делает вывод', () => {
    assert.equal(data.modules.find((m) => m.id === 'seatbelt_assessment')!.verified, null);
    for (const r of data.summary) assert.equal(r.module_status.seatbelt_assessment, 'unavailable');
  });

  it('пропуск кадров учтён, при отказе камеры ничего не придумано', () => {
    assert.ok(row('dropout')!.missing_frames! > 0);
    assert.equal(row('clear')!.missing_frames, 0);
  });

  it('отказ проверки формата', () => {
    assert.ok(validateCv({ format: 'x' }).length);
    const bad = JSON.parse(JSON.stringify(data));
    bad.summary[0].detection_recall_pct = [140, 0];
    assert.ok(validateCv(bad).length);
    bad.summary[0].detection_recall_pct = [50, 0];
    bad.summary[0].module_status.speed_estimation = 'great';
    assert.ok(validateCv(bad).length);
  });
});
