"""Статистика для сравнения контроллеров на одинаковых seed (без внешних зависимостей).

Прогоны с одним seed у разных контроллеров используют один и тот же файл маршрутов, поэтому сравнение
парное: для каждого seed берётся разность метрики, по разностям — среднее, 95 % доверительный интервал
(распределение Стьюдента) и знаковый тест (в скольких seed один контроллер лучше другого).
"""
from __future__ import annotations

import math
import statistics
from typing import Iterable, Sequence

_Z975 = 1.959963984540054


def t975(df: int) -> float:
    """Квантиль 0,975 распределения Стьюдента (для двустороннего 95 % интервала).

    df ≤ 30 — табличные значения, дальше — разложение Корниша — Фишера (погрешность < 1e-4).
    """
    table = (12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
             2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
             2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423)
    if df < 1:
        raise ValueError("нужна хотя бы одна степень свободы")
    if df <= len(table):
        return table[df - 1]
    z, v = _Z975, float(df)
    return (z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2)
            + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3))


def mean_ci(xs: Sequence[float]) -> tuple[float, float, float]:
    """Среднее и границы 95 % доверительного интервала среднего. Для одного значения интервал вырожден."""
    if not xs:
        raise ValueError("нет данных")
    m = statistics.fmean(xs)
    if len(xs) < 2:
        return m, m, m
    h = t975(len(xs) - 1) * statistics.stdev(xs) / math.sqrt(len(xs))
    return m, m - h, m + h


def sign_test_p(wins: int, losses: int) -> float:
    """Двусторонний знаковый тест: вероятность такого или более сильного перевеса при равных шансах (ничьи отброшены)."""
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    tail = sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def paired(a: dict[int, float | None], b: dict[int, float | None], lower_is_better: bool = True, tie: float = 1e-9) -> dict | None:
    """Парное сравнение A против B по общим seed.

    a, b — значение метрики по seed. Возвращает среднее A и B, среднюю разность A − B с 95 % ДИ,
    относительное изменение (A − B) / B с ДИ (ДИ разности, делённый на среднее B), число seed, где A лучше,
    хуже и одинаково, и p знакового теста. None — общих seed нет.
    """
    seeds = sorted(s for s in a if s in b and a[s] is not None and b[s] is not None)
    if not seeds:
        return None
    xa = [float(a[s]) for s in seeds]
    xb = [float(b[s]) for s in seeds]
    d = [x - y for x, y in zip(xa, xb)]
    m, lo, hi = mean_ci(d)
    mb = statistics.fmean(xb)
    better = sum(1 for x in d if (x < -tie if lower_is_better else x > tie))
    worse = sum(1 for x in d if (x > tie if lower_is_better else x < -tie))
    rel = (lambda v: round(v / mb, 4)) if mb else (lambda v: None)
    return {
        "n": len(seeds), "mean_a": round(statistics.fmean(xa), 3), "mean_b": round(mb, 3),
        "sd_a": round(statistics.stdev(xa), 3) if len(xa) > 1 else 0.0, "sd_b": round(statistics.stdev(xb), 3) if len(xb) > 1 else 0.0,
        "diff": round(m, 3), "diff_ci95": [round(lo, 3), round(hi, 3)], "sd_diff": round(statistics.stdev(d), 3) if len(d) > 1 else 0.0,
        "rel": rel(m), "rel_ci95": [rel(lo), rel(hi)],
        "a_better": better, "a_worse": worse, "ties": len(seeds) - better - worse, "p_sign": round(sign_test_p(better, worse), 6),
    }


def describe(xs: Iterable[float | None]) -> dict | None:
    """Среднее, ст. отклонение, 95 % ДИ среднего, минимум, медиана, максимум."""
    v = [float(x) for x in xs if x is not None]
    if not v:
        return None
    m, lo, hi = mean_ci(v)
    return {"n": len(v), "mean": round(m, 3), "sd": round(statistics.stdev(v), 3) if len(v) > 1 else 0.0,
            "ci95": [round(lo, 3), round(hi, 3)], "min": round(min(v), 3), "median": round(statistics.median(v), 3), "max": round(max(v), 3)}
