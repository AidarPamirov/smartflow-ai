"""Модуль seatbelt_assessment: демонстрационная оценка видимости ремня безопасности.

Честное состояние: специализированной модели в проекте нет, и универсальный детектор машин ремень
не распознаёт. Без подключённой модели результат всегда «невозможно определить».

Модуль задаёт интерфейс для подключения специализированной модели (обученной на датасете снимков салона
через лобовое стекло, с разметкой «пристёгнут / не пристёгнут / не видно») и строгие правила:
* сначала проверка качества фрагмента (разрешение, резкость, пересвет); плохое качество — «невозможно определить»;
* модель возвращает вероятность «ремень виден»; решение только при уверенности выше порога,
  промежуточные значения — «невозможно определить»;
* любой вывод «предположительно не пристёгнут» — предварительное событие, не заключение.
Изображения не сохраняются; на выходе только класс, уверенность и причина.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

import cv2
import numpy as np

BUCKLED = "предположительно пристёгнут"
UNBUCKLED = "предположительно не пристёгнут"
UNKNOWN = "невозможно определить"


class SeatbeltModel(Protocol):
    name: str
    validated_on: str | None  # на каком датасете проверена; None — не проверялась

    def __call__(self, crop: np.ndarray) -> float:
        """Вероятность того, что ремень виден и пристёгнут (0…1)."""


@dataclass(frozen=True)
class SeatbeltResult:
    label: str
    confidence: float | None
    reason: str


@dataclass(frozen=True)
class QualityGate:
    min_height_px: int = 96
    min_width_px: int = 96
    min_sharpness: float = 60.0  # дисперсия лапласиана
    max_glare_share: float = 0.25  # доля почти белых пикселей

    def check(self, crop: np.ndarray | None) -> str | None:
        """None — качество достаточное; иначе причина отказа."""
        if crop is None or crop.size == 0:
            return "нет изображения салона"
        h, w = crop.shape[:2]
        if h < self.min_height_px or w < self.min_width_px:
            return f"мало разрешения ({w}×{h} пкс)"
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
        if sharp < self.min_sharpness:
            return f"изображение размыто (резкость {sharp:.0f})"
        glare = float((g >= 245).mean())
        if glare > self.max_glare_share:
            return f"блики на стекле ({glare:.0%} кадра)"
        return None


class SeatbeltAssessor:
    def __init__(self, model: SeatbeltModel | Callable[[np.ndarray], float] | None = None, threshold: float = 0.8,
                 gate: QualityGate = QualityGate()):
        self.model = model
        self.threshold = threshold
        self.gate = gate

    @property
    def available(self) -> bool:
        return self.model is not None

    def assess(self, crop: np.ndarray | None) -> SeatbeltResult:
        if self.model is None:
            return SeatbeltResult(UNKNOWN, None, "модель распознавания ремня не подключена")
        bad = self.gate.check(crop)
        if bad:
            return SeatbeltResult(UNKNOWN, None, bad)
        p = float(self.model(crop))
        if not 0.0 <= p <= 1.0 or not np.isfinite(p):
            return SeatbeltResult(UNKNOWN, None, "модель вернула недопустимое значение")
        if p >= self.threshold:
            return SeatbeltResult(BUCKLED, round(p, 2), "уверенность выше порога")
        if p <= 1 - self.threshold:
            return SeatbeltResult(UNBUCKLED, round(1 - p, 2), "уверенность выше порога; событие предварительное")
        return SeatbeltResult(UNKNOWN, round(max(p, 1 - p), 2), "уверенность ниже порога")
