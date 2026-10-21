"""Модуль vehicle_detection: поиск машин в кадре.

Два детектора с одним интерфейсом `detect(frame) -> list[Detection]`:

* BackgroundDetector — классический, на OpenCV, без нейросети и без GPU: разница с моделью фона по цвету,
  морфология, контуры. Фон обновляется только там, где машин нет, поэтому стоящая в очереди машина
  не «растворяется» в фоне. Проверен на синтетической сцене (см. evaluate.py); на реальном видео
  не проверялся. Слабые места: слипание машин в плотной очереди, тени, смена освещения.
* YoloDetector — адаптер к внешней модели (пакет ultralytics и веса). В проекте не установлен
  и не проверялся; без пакета честно сообщает, что недоступен.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


class ModuleUnavailable(RuntimeError):
    """Модуль нельзя использовать: нет зависимости, модели или данных."""


@dataclass(frozen=True)
class Detection:
    box: tuple[float, float, float, float]  # x0, y0, x1, y1, пиксели
    score: float
    label: str = "vehicle"

    @property
    def bottom_center(self) -> tuple[float, float]:
        """Нижняя середина рамки — ближе всего к точке касания дороги (для перевода в метры)."""
        x0, _, x1, y1 = self.box
        return ((x0 + x1) / 2, y1)

    @property
    def area(self) -> float:
        x0, y0, x1, y1 = self.box
        return max(0.0, x1 - x0) * max(0.0, y1 - y0)


class BackgroundDetector:
    name = "background-subtraction (OpenCV)"
    verified = "синтетическая сцена"

    def __init__(self, threshold: int = 28, min_area_frac: float = 0.00012, learn_rate: float = 0.01, warmup_frames: int = 10,
                 roi: np.ndarray | None = None):
        self.threshold = threshold
        self.min_area_frac = min_area_frac
        self.learn_rate = learn_rate
        self.warmup = warmup_frames
        self.roi = roi  # маска области дороги (uint8, 0/255) или None — весь кадр
        self._bg: np.ndarray | None = None
        self._seen = 0
        self._stack: list[np.ndarray] = []

    def reset(self) -> None:
        self._bg, self._seen, self._stack = None, 0, []

    def detect(self, frame: np.ndarray) -> list[Detection]:
        # цветной кадр: машина того же тона, что асфальт, но другого цвета, в оттенках серого «пропадает»
        g = cv2.GaussianBlur(frame if frame.ndim == 3 else frame[..., None].repeat(3, axis=2), (5, 5), 0).astype(np.float32)
        if self._bg is None or self._bg.shape != g.shape:
            self._bg, self._seen, self._stack = None, 0, []
        self._seen += 1
        if self._seen <= self.warmup:
            # начальный фон — медиана первых кадров (машины в разных местах «вычитаются»)
            self._stack.append(g)
            self._bg = np.median(np.stack(self._stack), axis=0).astype(np.float32)
            return []
        diff = cv2.absdiff(g, self._bg).max(axis=2)
        mask = (diff > self.threshold).astype(np.uint8) * 255
        if self.roi is not None and self.roi.shape == mask.shape:
            mask = cv2.bitwise_and(mask, self.roi)
        k = max(3, int(round(min(g.shape[:2]) / 180)) | 1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
        # фон обновляется только вне найденных машин (с запасом)
        grown = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (4 * k + 1, 4 * k + 1)))
        cv2.accumulateWeighted(g, self._bg, self.learn_rate, mask=cv2.bitwise_not(grown))
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        min_area = self.min_area_frac * g.shape[0] * g.shape[1]
        out = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area < min_area:
                continue
            fill = area / max(w * h, 1)
            out.append(Detection((float(x), float(y), float(x + w), float(y + h)), score=round(min(1.0, 0.5 + fill / 2), 3)))
        return out


class YoloDetector:
    """Адаптер к YOLO (ultralytics). Не входит в зависимости проекта и не проверялся на данных проекта."""

    name = "YOLO (ultralytics), внешний"
    verified = None
    VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}

    def __init__(self, weights: str = "yolov8n.pt", conf: float = 0.35):
        try:
            from ultralytics import YOLO  # type: ignore[import-not-found]
        except ImportError as e:
            raise ModuleUnavailable("пакет ultralytics не установлен: детектор YOLO недоступен (pip install ultralytics и файл весов)") from e
        self.model = YOLO(weights)
        self.conf = conf

    def reset(self) -> None:
        pass

    def detect(self, frame: np.ndarray) -> list[Detection]:  # pragma: no cover — нужна внешняя модель
        res = self.model(frame, conf=self.conf, verbose=False)[0]
        out = []
        for b, c, s in zip(res.boxes.xyxy.tolist(), res.boxes.cls.tolist(), res.boxes.conf.tolist()):
            label = res.names[int(c)]
            if label in self.VEHICLE_CLASSES:
                out.append(Detection(tuple(b), float(s), label))
        return out
