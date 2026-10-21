"""Статистика парного сравнения: квантили Стьюдента, интервал, знаковый тест."""
import unittest

from smartflow_sumo.stats import describe, mean_ci, paired, sign_test_p, t975


class StatsTests(unittest.TestCase):
    def test_t_quantiles(self):
        # табличные значения t(0,975): df = 1, 10, 29, 60, 120
        for df, want in ((1, 12.7062), (10, 2.2281), (29, 2.0452), (60, 2.0003), (120, 1.9799)):
            self.assertAlmostEqual(t975(df), want, places=3, msg=f"df={df}")
        with self.assertRaises(ValueError):
            t975(0)

    def test_mean_ci(self):
        m, lo, hi = mean_ci([1.0, 2.0, 3.0])
        self.assertAlmostEqual(m, 2.0)
        self.assertAlmostEqual(hi - m, 4.3027 * 1.0 / 3 ** 0.5, places=3)
        self.assertEqual(mean_ci([5.0]), (5.0, 5.0, 5.0))

    def test_sign_test(self):
        self.assertAlmostEqual(sign_test_p(25, 5), 0.000325, places=6)
        self.assertEqual(sign_test_p(15, 15), 1.0)
        self.assertEqual(sign_test_p(0, 0), 1.0)
        self.assertAlmostEqual(sign_test_p(30, 0), 2 / 2 ** 30)

    def test_paired_uses_common_seeds_and_direction(self):
        a = {1: 10.0, 2: 12.0, 3: 9.0, 4: None}
        b = {1: 20.0, 2: 21.0, 3: 19.0, 5: 30.0}
        r = paired(a, b)
        self.assertEqual(r["n"], 3)
        self.assertAlmostEqual(r["diff"], -9.667, places=3)
        self.assertLess(r["diff_ci95"][1], 0)
        self.assertEqual((r["a_better"], r["a_worse"], r["ties"]), (3, 0, 0))
        up = paired(a, b, lower_is_better=False)
        self.assertEqual((up["a_better"], up["a_worse"]), (0, 3))
        self.assertIsNone(paired({1: 1.0}, {2: 1.0}))

    def test_identical_runs_are_ties(self):
        r = paired({1: 5.0, 2: 6.0}, {1: 5.0, 2: 6.0})
        self.assertEqual((r["diff"], r["ties"], r["p_sign"]), (0.0, 2, 1.0))

    def test_describe(self):
        d = describe([1, 2, None, 3])
        self.assertEqual((d["n"], d["min"], d["median"], d["max"]), (3, 1.0, 2.0, 3.0))
        self.assertIsNone(describe([None]))


if __name__ == "__main__":
    unittest.main()
