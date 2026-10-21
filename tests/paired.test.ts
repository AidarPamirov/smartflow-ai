import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseComparisons, verdict, type Comparison } from '../src/sumo/paired';

const base: Comparison = {
  load: 'medium', a: 'adaptive', b: 'fixed', metric: 'mean_wait', lower_is_better: true, n: 30, mean_a: 20, mean_b: 34, sd_a: 1, sd_b: 1.5,
  diff: -14, diff_ci95: [-14.5, -13.5], sd_diff: 1.2, rel: -0.41, rel_ci95: [-0.43, -0.4], a_better: 30, a_worse: 0, ties: 0, p_sign: 1.9e-9,
};

describe('парные сравнения: вывод только по доверительному интервалу', () => {
  it('интервал целиком ниже нуля при «меньше — лучше» → лучше; выше → хуже', () => {
    assert.equal(verdict(base), 'better');
    assert.equal(verdict({ ...base, diff: 3, diff_ci95: [1, 5] }), 'worse');
  });
  it('интервал захватывает ноль → разница не подтверждена, даже если среднее лучше', () => {
    assert.equal(verdict({ ...base, diff: -1, diff_ci95: [-3, 1], a_better: 18, a_worse: 12 }), 'unclear');
  });
  it('для «больше — лучше» знак обратный; все seed одинаковы → одинаково', () => {
    assert.equal(verdict({ ...base, lower_is_better: false }), 'worse');
    assert.equal(verdict({ ...base, diff: 0, diff_ci95: [0, 0], a_better: 0, ties: 30 }), 'same');
  });
  it('проверка формата ловит несогласованные записи', () => {
    assert.doesNotThrow(() => parseComparisons([base]));
    assert.throws(() => parseComparisons([{ ...base, diff: -20 }]), /вне своего интервала/);
    assert.throws(() => parseComparisons([{ ...base, a_better: 29 }]), /не сходится/);
    assert.throws(() => parseComparisons({}));
  });
});
