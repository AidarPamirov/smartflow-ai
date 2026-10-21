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


class YoloxOnnxDetector:
    """Нейросетевой детектор YOLOX (Megvii, Apache-2.0), предобученный на COCO, через OpenCV DNN — без PyTorch и GPU.

    Веса (файл .onnx) в проект не входят: их скачивает detrac_eval.py из копии на Hugging Face (hr16/yolox-onnx).
    Дообучения на дорогах Бишкека нет. Машинами считаются классы COCO car, bus, truck.
    """

    name = "YOLOX (COCO, OpenCV DNN)"
    verified = "UA-DETRAC: реальное размеченное видео, см. detrac_eval.py"
    VEHICLE_CLASSES = (2, 5, 7)  # car, bus, truck в нумерации COCO

    def __init__(self, weights: str, input_size: int = 416, conf: float = 0.3, nms: float = 0.45):
        import os
        if not os.path.exists(weights):
            raise ModuleUnavailable(f"нет файла весов {weights}: детектор YOLOX недоступен")
        self.net = cv2.dnn.readNetFromONNX(weights)
        self.size, self.conf, self.nms = input_size, conf, nms
        grids, strides = [], []
        for s in (8, 16, 32):
            n = input_size // s
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), s))
        self._grid, self._stride = np.concatenate(grids).astype(np.float32), np.concatenate(strides).astype(np.float32)

    def reset(self) -> None:
        pass

    def detect(self, frame: np.ndarray) -> list[Detection]:
        h, w = frame.shape[:2]
        r = min(self.size / h, self.size / w)
        pad = np.full((self.size, self.size, 3), 114, np.uint8)
        rs = cv2.resize(frame, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        pad[:rs.shape[0], :rs.shape[1]] = rs
        self.net.setInput(pad.transpose(2, 0, 1)[None].astype(np.float32))
        out = self.net.forward()[0]
        xy = (out[:, :2] + self._grid) * self._stride
        wh = np.exp(out[:, 2:4]) * self._stride
        scores = out[:, 4:5] * out[:, 5:]
        cls = scores.argmax(1)
        conf = scores[np.arange(len(cls)), cls]
        keep = (conf >= self.conf) & np.isin(cls, self.VEHICLE_CLASSES)
        if not keep.any():
            return []
        xy, wh, conf, cls = xy[keep] / r, wh[keep] / r, conf[keep], cls[keep]
        boxes = [[float(x - bw / 2), float(y - bh / 2), float(bw), float(bh)] for (x, y), (bw, bh) in zip(xy, wh)]
        idx = cv2.dnn.NMSBoxes(boxes, conf.tolist(), self.conf, self.nms)
        names = {2: "car", 5: "bus", 7: "truck"}
        out_d = []
        for i in np.array(idx).reshape(-1):
            x, y, bw, bh = boxes[i]
            out_d.append(Detection((max(0.0, x), max(0.0, y), min(float(w), x + bw), min(float(h), y + bh)), round(float(conf[i]), 3), names[int(cls[i])]))
        return out_d


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
