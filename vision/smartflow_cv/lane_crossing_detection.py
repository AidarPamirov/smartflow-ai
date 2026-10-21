"""Модуль lane_crossing_detection: пересечение сплошной линии траекторией машины.

Линия задаётся отрезком в метрах на плоскости дороги (по калибровке), а не линией на экране.
Событие возникает, только если точка трека перешла с одной стороны линии на другую с запасом
(гистерезис min_depth_m), а место пересечения лежит в пределах отрезка. Неглубокий переход,
трек, потерянный у линии, или пересечение у края отрезка — «недостаточно данных», а не нарушение.
Любое событие — предварительное, не юридическое заключение.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GroundLine:
    p: tuple[float, float]
    q: tuple[float, float]
    name: str = "solid"

    def side(self, x: float, y: float) -> float:
        """Знаковое расстояние до прямой (м): > 0 — слева от направления p → q."""
        px, py = self.p
        qx, qy = self.q
        L = float(np.hypot(qx - px, qy - py))
        return ((qx - px) * (y - py) - (qy - py) * (x - px)) / L

    def param(self, x: float, y: float) -> float:
        """Положение проекции точки на отрезок: 0 — в p, 1 — в q."""
        px, py = self.p
        qx, qy = self.q
        d = np.array([qx - px, qy - py])
        return float(np.dot([x - px, y - py], d) / np.dot(d, d))


@dataclass(frozen=True)
class CrossingEvent:
    t: float
    track: int  # анонимный номер трека
    line: str
    direction: str  # «слева направо» / «справа налево» относительно направления линии
    x: float
    y: float
    depth_m: float
    confidence: float
    status: str  # potential_violation | insufficient_data


class LineCrossingDetector:
    def __init__(self, line: GroundLine, min_depth_m: float = 0.6, edge_margin: float = 0.03, min_confidence: float = 0.5,
                 max_lateral_speed: float = 4.0):
        self.line = line
        #: поперечная скорость точки трека выше этой — не манёвр, а скачок рамки (слияние двух машин в одно пятно,
        #: заслонение); пересечение со скачком считается «недостаточно данных»
        self.max_lat = max_lateral_speed
        self.min_depth = min_depth_m
        self.edge_margin = edge_margin
        self.min_confidence = min_confidence
        self._state: dict[int, dict] = {}

    def reset(self) -> None:
        self._state = {}

    def update(self, tid: int, t: float, x: float, y: float, quality: float = 1.0) -> CrossingEvent | None:
        """Новая точка трека на дороге. Возвращает событие, когда переход завершён."""
        if not (np.isfinite(x) and np.isfinite(y)):
            return None
        s = self.line.side(x, y)
        st = self._state.setdefault(tid, {"stable": None, "cross": None, "last": None, "jump": False})
        if st["last"] is not None:
            lt, ls = st["last"]
            if t > lt and abs(s - ls) / (t - lt) > self.max_lat and abs(s - ls) > 0.3:
                st["jump"] = True
        st["last"] = (t, s)
        stable_now = 1 if s >= self.min_depth else -1 if s <= -self.min_depth else 0
        if st["stable"] is None:
            if stable_now:
                st["stable"] = stable_now
            return None
        if np.sign(s) != st["stable"] and s != 0 and st["cross"] is None:
            st["cross"] = (t, x, y)  # точка, где трек перешёл через линию
        if np.sign(s) == st["stable"] and abs(s) >= self.min_depth:
            st["cross"] = None  # на своей стороне уверенно: пересечения нет, прежние скачки не в счёт
            st["jump"] = False
        if stable_now and stable_now != st["stable"]:
            ct, cx, cy = st["cross"] or (t, x, y)
            prev, jumped = st["stable"], st["jump"]
            st["stable"], st["cross"], st["jump"] = stable_now, None, False
            u = self.line.param(cx, cy)
            if not (-self.edge_margin <= u <= 1 + self.edge_margin):
                return None  # пересекли продолжение линии, а не саму сплошную
            conf = float(np.clip(quality * min(1.0, abs(s) / (2 * self.min_depth)), 0, 1))
            near_edge = u < self.edge_margin or u > 1 - self.edge_margin
            status = "insufficient_data" if conf < self.min_confidence or near_edge or jumped else "potential_violation"
            if status == "potential_violation":
                if st.get("reported"):
                    return None  # одно событие на трек: заезд и возврат — один манёвр
                st["reported"] = True
            return CrossingEvent(round(ct, 2), tid, self.line.name, "слева направо" if prev > 0 else "справа налево",
                                 round(cx, 2), round(cy, 2), round(abs(s), 2), round(conf, 2), status)
        return None

    def lost(self, tid: int, t: float) -> CrossingEvent | None:
        """Трек потерян. Если в этот момент машина была на линии — «недостаточно данных»."""
        st = self._state.pop(tid, None)
        if st and st["cross"] is not None:
            ct, cx, cy = st["cross"]
            u = self.line.param(cx, cy)
            if 0 <= u <= 1:
                return CrossingEvent(round(ct, 2), tid, self.line.name, "?", round(cx, 2), round(cy, 2), 0.0, 0.0, "insufficient_data")
        return None
