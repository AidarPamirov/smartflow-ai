"""Модуль traffic_density_estimation: плотность, занятость, очередь и поток по трекам на плоскости дороги.

Все величины — агрегированные (числа машин и метры), без изображений и без отслеживания конкретных людей.
Без калибровки метрические показатели недоступны: доступно только число машин в кадре.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Zone:
    """Участок дороги: полосы как интервалы поперёк (y, м) и отрезок вдоль (x, м)."""

    x0: float
    x1: float
    lanes: tuple[tuple[float, float], ...]
    stop_x: float | None = None  # стоп-линия (для длины очереди)
    count_x: float | None = None  # линия подсчёта потока


@dataclass(frozen=True)
class DensitySnapshot:
    status: str  # ok | no_calibration
    vehicles_in_frame: int
    per_lane: tuple[int, ...] | None = None
    density_veh_km_lane: float | None = None
    queue_m: tuple[float, ...] | None = None  # длина очереди от стоп-линии по полосам


class DensityEstimator:
    def __init__(self, zone: Zone, stopped_kmh: float = 5.0, queue_gap_m: float = 12.0):
        self.zone = zone
        self.stopped_kmh = stopped_kmh
        self.queue_gap = queue_gap_m
        self._last_x: dict[int, float] = {}
        self.counted = 0
        self.t_first: float | None = None
        self.t_last: float | None = None

    def reset(self) -> None:
        self._last_x, self.counted, self.t_first, self.t_last = {}, 0, None, None

    def lane_of(self, y: float) -> int | None:
        for k, (a, b) in enumerate(self.zone.lanes):
            if a <= y < b:
                return k
        return None

    def update(self, t: float, points: list[tuple[int, float, float, float | None]], calibrated: bool, n_detections: int) -> DensitySnapshot:
        """points — (трек, x, y, скорость км/ч или None) подтверждённых треков в метрах."""
        if self.t_first is None:
            self.t_first = t
        self.t_last = t
        if not calibrated:
            return DensitySnapshot("no_calibration", n_detections)
        z = self.zone
        per = [0] * len(z.lanes)
        stopped: list[list[float]] = [[] for _ in z.lanes]
        for tid, x, y, sp in points:
            if z.count_x is not None:
                px = self._last_x.get(tid)
                if px is not None and px < z.count_x <= x:
                    self.counted += 1
                self._last_x[tid] = x
            k = self.lane_of(y)
            if k is None or not (z.x0 <= x <= z.x1):
                continue
            per[k] += 1
            if sp is not None and sp <= self.stopped_kmh:
                stopped[k].append(x)
        queue = []
        for xs in stopped:
            q = 0.0
            if z.stop_x is not None and xs:
                edge = z.stop_x
                for x in sorted(xs, reverse=True):
                    if edge - x <= self.queue_gap:
                        q, edge = z.stop_x - x, x
                    else:
                        break
            queue.append(round(q, 1))
        dens = sum(per) / ((z.x1 - z.x0) / 1000) / len(z.lanes)
        return DensitySnapshot("ok", n_detections, tuple(per), round(dens, 1), tuple(queue))

    def flow_veh_h(self) -> float | None:
        if self.zone.count_x is None or self.t_first is None or self.t_last is None or self.t_last - self.t_first < 30:
            return None
        return round(self.counted / (self.t_last - self.t_first) * 3600, 0)
