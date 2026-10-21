"""Обработка записанного тестового видео.

    python -m smartflow_cv.run --video clip.mp4 --calibration calib.json --config camera.json --out events.json

* --calibration — JSON с гомографией (см. calibration.Calibration.to_json); без него скорость
  и пересечение линии не считаются (статус «нет калибровки»).
* --config — линия разметки и зона в метрах, ограничение скорости; без него — только детекция и треки.
* --disable МОДУЛЬ … — выключить модули.
На выходе — агрегированные метрики и анонимные события. Кадры, лица и номера не сохраняются.
Подключение к живым камерам в проекте не реализовано.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from .calibration import Calibration
from .lane_crossing_detection import GroundLine
from .pipeline import MODULES, Pipeline, PipelineConfig
from .traffic_density_estimation import Zone
from .vehicle_detection import BackgroundDetector, ModuleUnavailable, YoloDetector


def load_config(path: Path | None) -> PipelineConfig:
    cfg = PipelineConfig()
    if path is None:
        return cfg
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    cfg.speed_limit_kmh = float(d.get("speed_limit_kmh", cfg.speed_limit_kmh))
    cfg.speed_tolerance_kmh = float(d.get("speed_tolerance_kmh", cfg.speed_tolerance_kmh))
    cfg.min_confidence = float(d.get("min_confidence", cfg.min_confidence))
    if "solid_line" in d:
        cfg.solid_line = GroundLine(tuple(d["solid_line"]["p"]), tuple(d["solid_line"]["q"]), d["solid_line"].get("name", "solid"))
    if "zone" in d:
        z = d["zone"]
        cfg.zone = Zone(z["x0"], z["x1"], tuple(tuple(l) for l in z["lanes"]), z.get("stop_x"), z.get("count_x"))
    return cfg


def process_video(video: Path, cfg: PipelineConfig, cal: Calibration | None, detector=None, max_frames: int | None = None) -> dict:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise FileNotFoundError(f"видео не открывается: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    pipe = Pipeline(cfg, cal, detector=detector or BackgroundDetector())
    n = 0
    per_frame_vehicles = []
    try:
        while max_frames is None or n < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if cal is not None and (frame.shape[1], frame.shape[0]) != tuple(cal.image_size):
                raise ValueError(f"размер кадра {frame.shape[1]}×{frame.shape[0]} не совпадает с калибровкой {cal.image_size}")
            res = pipe.process(n / fps, frame)
            per_frame_vehicles.append(len(res.tracks))
            n += 1
    finally:
        cap.release()
    s = pipe.summary()
    return {
        "format": "smartflow-cv-run/1", "source": {"type": "test_video", "file": Path(video).name, "fps": fps, "frames": n},
        "calibration": cal.source if cal else None,
        "modules": pipe.module_status(True),
        "detector": getattr(pipe.detector, "name", type(pipe.detector).__name__),
        "mean_tracked_vehicles": round(sum(per_frame_vehicles) / n, 2) if n else None,
        **s,
        "note": "События предварительные, не юридическое заключение. Кадры не сохранялись.",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="SmartFlow CV: обработка тестового видео")
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--calibration", type=Path)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--detector", choices=["background", "yolo"], default="background")
    ap.add_argument("--disable", nargs="*", default=[], choices=MODULES)
    ap.add_argument("--max-frames", type=int)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
        for m in a.disable:
            cfg.enabled[m] = False
        cal = Calibration.load(a.calibration) if a.calibration else None
        det = YoloDetector() if a.detector == "yolo" else None
        out = process_video(a.video, cfg, cal, det, a.max_frames)
    except (FileNotFoundError, ValueError, ModuleUnavailable) as e:
        print(f"ошибка: {e}", file=sys.stderr)
        return 2
    text = json.dumps(out, ensure_ascii=False, indent=1)
    if a.out:
        a.out.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
