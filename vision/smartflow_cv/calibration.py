"""Калибровка камеры: соответствие пикселей изображения и плоскости дороги (метры).

Плоскость дороги задаётся гомографией H (3×3): [u, v, 1]ᵀ ~ H · [x, y, 1]ᵀ, где (x, y) — метры на дороге,
(u, v) — пиксели. Гомография восстанавливается по ≥ 4 опорным точкам с известными координатами
(например, углы разметки известного размера). Без калибровки скорость и пересечение линии
не вычисляются: модули возвращают статус «нет калибровки», а не число.

Ограничение: гомография верна только для точек на плоскости дороги. Точки на кузове (выше земли)
проецируются дальше и в сторону — поэтому для машины берётся нижняя точка рамки.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class CalibrationError(ValueError):
    pass


@dataclass(frozen=True)
class Calibration:
    """Гомография «дорога → изображение» и обратная к ней."""

    ground_to_image: np.ndarray  # 3×3
    image_size: tuple[int, int]  # (ширина, высота) кадра, для которого получена калибровка
    source: str = "unknown"  # откуда: «synthetic-exact», «points:<n>» и т. п.
    reprojection_error_px: float | None = None

    def __post_init__(self):
        h = np.asarray(self.ground_to_image, dtype=float)
        if h.shape != (3, 3) or not np.all(np.isfinite(h)) or abs(np.linalg.det(h)) < 1e-12:
            raise CalibrationError("гомография должна быть невырожденной матрицей 3×3")
        object.__setattr__(self, "ground_to_image", h)
        object.__setattr__(self, "_inv", np.linalg.inv(h))
        # знак третьей координаты для точек перед камерой: по точке дороги, видимой в центре кадра
        w, hgt = self.image_size
        q = self._inv @ np.array([w / 2, hgt / 2, 1.0])
        g = np.array([q[0] / q[2], q[1] / q[2], 1.0])
        object.__setattr__(self, "_front", float(np.sign((h @ g)[2])) or 1.0)

    @classmethod
    def from_points(cls, ground_m: list[tuple[float, float]], image_px: list[tuple[float, float]], image_size: tuple[int, int]) -> "Calibration":
        """По опорным точкам (≥ 4, не на одной прямой). Возвращает калибровку с ошибкой перепроекции."""
        if len(ground_m) != len(image_px) or len(ground_m) < 4:
            raise CalibrationError("нужно не меньше 4 пар точек «дорога — изображение»")
        g = np.asarray(ground_m, dtype=np.float64)
        p = np.asarray(image_px, dtype=np.float64)
        if np.linalg.matrix_rank(np.c_[g, np.ones(len(g))]) < 3:
            raise CalibrationError("опорные точки лежат на одной прямой")
        h = _dlt(g, p)
        cal = cls(h, image_size, source=f"points:{len(g)}")
        err = float(np.max(np.linalg.norm(cal.to_image(g) - p, axis=1)))
        return cls(h, image_size, source=f"points:{len(g)}", reprojection_error_px=round(err, 3))

    def to_image(self, ground_xy) -> np.ndarray:
        """Метры на дороге → пиксели. Точки за камерой дают NaN."""
        g = np.asarray(ground_xy, dtype=float).reshape(-1, 2)
        out, w = _apply(self.ground_to_image, g)
        out[w * self._front <= 0] = np.nan
        return out

    def to_ground(self, image_uv) -> np.ndarray:
        """Пиксели → метры на плоскости дороги. Пиксели над горизонтом (не на дороге) дают NaN."""
        g, _ = _apply(self._inv, image_uv)
        _, w = _apply(self.ground_to_image, np.nan_to_num(g))
        g[~np.isfinite(g).all(axis=1) | (w * self._front <= 0)] = np.nan
        return g

    def meters_per_pixel(self, image_uv) -> float:
        """Масштаб около точки изображения (средний по осям), м/пкс — для оценки точности."""
        u, v = np.asarray(image_uv, dtype=float).reshape(2)
        a, b, c = self.to_ground([[u, v], [u + 1, v], [u, v + 1]])
        return float((np.linalg.norm(b - a) + np.linalg.norm(c - a)) / 2)

    def to_json(self) -> dict:
        return {"ground_to_image": self.ground_to_image.tolist(), "image_size": list(self.image_size), "source": self.source,
                "reprojection_error_px": self.reprojection_error_px}

    @classmethod
    def from_json(cls, d: dict) -> "Calibration":
        return cls(np.asarray(d["ground_to_image"], dtype=float), tuple(d["image_size"]), d.get("source", "file"), d.get("reprojection_error_px"))

    @classmethod
    def load(cls, path: Path) -> "Calibration":
        return cls.from_json(json.loads(Path(path).read_text(encoding="utf-8")))


def _apply(h: np.ndarray, pts) -> tuple[np.ndarray, np.ndarray]:
    p = np.asarray(pts, dtype=float).reshape(-1, 2)
    q = np.c_[p, np.ones(len(p))] @ h.T
    w = q[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        out = q[:, :2] / w[:, None]
    out[np.abs(w) < 1e-12] = np.nan
    return out, w


def _dlt(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Нормализованный DLT (Хартли): гомография src → dst по МНК."""
    def norm(p):
        c = p.mean(axis=0)
        s = np.sqrt(2) / max(np.mean(np.linalg.norm(p - c, axis=1)), 1e-12)
        return np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]])

    ts, td = norm(src), norm(dst)
    s = (np.c_[src, np.ones(len(src))] @ ts.T)[:, :2]
    d = (np.c_[dst, np.ones(len(dst))] @ td.T)[:, :2]
    rows = []
    for (x, y), (u, v) in zip(s, d):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.asarray(rows))
    h = vt[-1].reshape(3, 3)
    h = np.linalg.inv(td) @ h @ ts
    return h / h[2, 2]
