"""Модуль speed_estimation: скорость по перемещению на плоскости дороги за известное время.

Скорость считается только по откалиброванным координатам (метры) и меткам времени кадров:
наклон прямой x(t), y(t) за последнее окно (МНК). По размеру машины в кадре скорость не оценивается.
Без калибровки — статус «нет калибровки», без достаточной истории — «недостаточно данных».
Уверенность снижается при большом разбросе точек и при грубом масштабе (м на пиксель) вдали от камеры.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SpeedEstimate:
    status: str  # ok | no_calibration | insufficient_data
    speed_kmh: float | None = None
    heading_deg: float | None = None  # направление на дороге: 0° — вдоль оси x
    confidence: float | None = None
    window_s: float | None = None


def estimate_speed(history: list[tuple[float, float, float, float, float]], calibrated: bool, window_s: float = 1.0,
                   min_points: int = 8, m_per_px: float | None = None) -> SpeedEstimate:
    """history — точки трека (t, u, v, x, y), по возрастанию t."""
    if not calibrated:
        return SpeedEstimate("no_calibration")
    if not history:
        return SpeedEstimate("insufficient_data")
    t_end = history[-1][0]
    pts = np.array([(t, x, y) for (t, _, _, x, y) in history if t >= t_end - window_s and np.isfinite(x) and np.isfinite(y)])
    if len(pts) < min_points or pts[-1, 0] - pts[0, 0] < 0.6 * window_s:
        return SpeedEstimate("insufficient_data")
    t = pts[:, 0] - pts[:, 0].mean()
    den = float((t ** 2).sum())
    vx = float((t * (pts[:, 1] - pts[:, 1].mean())).sum() / den)
    vy = float((t * (pts[:, 2] - pts[:, 2].mean())).sum() / den)
    res = np.hypot(pts[:, 1] - pts[:, 1].mean() - vx * t, pts[:, 2] - pts[:, 2].mean() - vy * t)
    spread = float(np.sqrt((res ** 2).mean()))
    sp = float(np.hypot(vx, vy))
    # стандартная ошибка наклона, м/с
    se = spread / np.sqrt(den) if den > 0 else float("inf")
    if m_per_px:
        se = max(se, m_per_px / (pts[-1, 0] - pts[0, 0]))  # одна точка разрешения на окно
    conf = float(np.clip(1.0 - se / max(sp, 2.0), 0.0, 1.0))
    return SpeedEstimate("ok", round(sp * 3.6, 1), round(float(np.degrees(np.arctan2(vy, vx))), 1), round(conf, 2), round(float(pts[-1, 0] - pts[0, 0]), 2))


@dataclass(frozen=True)
class SpeedCheck:
    status: str  # over | within | unknown
    limit_kmh: float
    tolerance_kmh: float
    detail: str


def check_limit(est: SpeedEstimate, limit_kmh: float, tolerance_kmh: float = 5.0, min_confidence: float = 0.6) -> SpeedCheck:
    """Сравнение с демонстрационным ограничением. Без уверенной оценки — «неизвестно», а не превышение."""
    if est.status != "ok" or est.speed_kmh is None:
        return SpeedCheck("unknown", limit_kmh, tolerance_kmh, {"no_calibration": "нет калибровки", "insufficient_data": "недостаточно данных"}.get(est.status, est.status))
    if (est.confidence or 0) < min_confidence:
        return SpeedCheck("unknown", limit_kmh, tolerance_kmh, f"низкая уверенность {est.confidence}")
    if est.speed_kmh > limit_kmh + tolerance_kmh:
        return SpeedCheck("over", limit_kmh, tolerance_kmh, f"{est.speed_kmh} км/ч при ограничении {limit_kmh} (+{tolerance_kmh} допуск)")
    return SpeedCheck("within", limit_kmh, tolerance_kmh, f"{est.speed_kmh} км/ч")
