"""Модуль vehicle_tracking: сопровождение машин между кадрами (multi-object tracking).

Простой трекер в духе SORT без фильтра Калмана: сопоставление рамок кадра с треками по IoU венгерским
алгоритмом, с предсказанием рамки по скорости трека. Номера треков — анонимные порядковые числа
внутри одного прогона: по ним нельзя узнать машину, номер или человека. Изображения не хранятся.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

from .vehicle_detection import Detection


def iou(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


@dataclass
class Track:
    tid: int
    box: tuple[float, float, float, float]
    t_last: float
    hits: int = 1
    misses: int = 0
    #: история: (t, u, v нижней середины рамки, x, y на дороге или NaN без калибровки)
    history: list[tuple[float, float, float, float, float]] = field(default_factory=list)
    vel_px: tuple[float, float] = (0.0, 0.0)

    @property
    def confirmed(self) -> bool:
        return self.hits >= 3

    def predicted(self, t: float) -> tuple[float, float, float, float]:
        dt = t - self.t_last
        dx, dy = self.vel_px[0] * dt, self.vel_px[1] * dt
        x0, y0, x1, y1 = self.box
        return (x0 + dx, y0 + dy, x1 + dx, y1 + dy)


class Tracker:
    def __init__(self, iou_min: float = 0.15, max_age_s: float = 0.6, keep_history_s: float = 4.0):
        self.iou_min = iou_min
        self.max_age_s = max_age_s
        self.keep_history_s = keep_history_s
        self.tracks: list[Track] = []
        self._next = 1
        self.ended: list[Track] = []
        self.frame_h: int | None = None

    def reset(self) -> None:
        self.tracks, self._next, self.ended = [], 1, []

    def update(self, t: float, dets: list[Detection], to_ground=None) -> list[Track]:
        """Сопоставить рамки кадра t с треками. to_ground — функция пиксели → метры (или None)."""
        preds = [tr.predicted(t) for tr in self.tracks]
        matched_t, matched_d = set(), set()
        if self.tracks and dets:
            cost = np.array([[1 - iou(p, d.box) for d in dets] for p in preds])
            rows, cols = linear_sum_assignment(cost)
            for r, c in zip(rows, cols):
                if 1 - cost[r, c] >= self.iou_min:
                    matched_t.add(r)
                    matched_d.add(c)
                    self._update(self.tracks[r], t, dets[c], to_ground)
        for i, tr in enumerate(self.tracks):
            if i not in matched_t:
                tr.misses += 1
        for j, d in enumerate(dets):
            if j not in matched_d:
                tr = Track(self._next, d.box, t)
                self._next += 1
                self._record(tr, t, d, to_ground)
                self.tracks.append(tr)
        alive = []
        for tr in self.tracks:
            (alive if t - tr.t_last <= self.max_age_s else self.ended).append(tr)
        self.tracks = alive
        return [tr for tr in self.tracks if tr.confirmed and tr.t_last == t]

    def _update(self, tr: Track, t: float, d: Detection, to_ground) -> None:
        dt = t - tr.t_last
        if dt > 0:
            c_old = ((tr.box[0] + tr.box[2]) / 2, (tr.box[1] + tr.box[3]) / 2)
            c_new = ((d.box[0] + d.box[2]) / 2, (d.box[1] + d.box[3]) / 2)
            v = ((c_new[0] - c_old[0]) / dt, (c_new[1] - c_old[1]) / dt)
            tr.vel_px = (0.6 * tr.vel_px[0] + 0.4 * v[0], 0.6 * tr.vel_px[1] + 0.4 * v[1])
        tr.box, tr.t_last = d.box, t
        tr.hits += 1
        tr.misses = 0
        self._record(tr, t, d, to_ground)

    def _record(self, tr: Track, t: float, d: Detection, to_ground) -> None:
        u, v = d.bottom_center
        x = y = float("nan")
        # рамка, обрезанная нижним краем кадра, не даёт точки касания дороги — метры не считаются
        if to_ground is not None and not (self.frame_h and d.box[3] >= self.frame_h - 2):
            g = to_ground([[u, v]])[0]
            x, y = float(g[0]), float(g[1])
        tr.history.append((t, u, v, x, y))
        while tr.history and tr.history[0][0] < t - self.keep_history_s:
            tr.history.pop(0)
