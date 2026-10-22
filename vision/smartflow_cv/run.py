"""Обработка записанного тестового видео.

    python -m smartflow_cv.run --video clip.mp4 --calibration calib.json --config camera.json --out events.json

* --calibration — JSON с гомографией (см. calibration.Calibration.to_json); без него скорость
  и пересечение линии не считаются (статус «нет калибровки»).
* --config — линия разметки и зона в метрах, ограничение скорости; без него — только детекция и треки.
* --disable МОДУЛЬ … — выключить модули.
* --detector yolox — нейросеть YOLOX-tiny (веса скачиваются в ~/.cache при первом запуске).
* --save-video out.mp4 — записать видео с разметкой (рамки, номера треков, скорость, линия, события), чтобы его посмотреть;
  --show — показать разметку в окне (нужен OpenCV с поддержкой окон, а не headless).
На выходе — агрегированные метрики и анонимные события. Без --save-video кадры не сохраняются; лица и номера не распознаются.
Подключение к живым камерам в проекте не реализовано.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

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


def draw(frame, res, pipe: Pipeline, t: float, recent: list) -> np.ndarray:
    """Кадр с разметкой модулей: сырые детекции (серые), треки с номером и скоростью (зелёные), линия, события."""
    img = frame.copy()
    s = max(0.6, img.shape[0] / 540)
    if pipe.cal is not None and pipe.cfg.solid_line is not None:
        ln = pipe.cfg.solid_line
        q = pipe.cal.to_image([list(ln.p), list(ln.q)])
        cv2.line(img, tuple(np.round(q[0]).astype(int)), tuple(np.round(q[1]).astype(int)), (0, 200, 255), max(1, round(3 * s)))
    for d in res.detections:
        x0, y0, x1, y1 = map(int, d.box)
        cv2.rectangle(img, (x0, y0), (x1, y1), (130, 130, 130), 1)
    flagged = {e["track"] for _, e in recent}
    for tr in res.tracks:
        x0, y0, x1, y1 = map(int, tr["box"])
        color = (40, 60, 230) if tr["track"] in flagged else (60, 220, 60)
        cv2.rectangle(img, (x0, y0), (x1, y1), color, max(1, round(2 * s)))
        label = f"#{tr['track']}" + (f" {tr['speed_kmh']:.0f} km/h" if tr["speed_kmh"] is not None else "")
        cv2.putText(img, label, (x0, max(12, y0 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * s, (255, 255, 255), 1, cv2.LINE_AA)
    y = 20
    for _, e in recent[-4:]:
        txt = {"speed_over_limit": f"#{e['track']} speed {e.get('speed_kmh', 0):.0f} km/h > {e.get('limit_kmh', 0):.0f} (preliminary)",
               "solid_line_crossing": f"#{e['track']} crossed solid line (preliminary)",
               "solid_line_insufficient_data": f"#{e['track']} solid line: not enough data"}.get(e["type"], f"#{e['track']} {e['type']}")
        cv2.putText(img, txt, (8, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * s, (40, 60, 230), 1, cv2.LINE_AA)
        y += int(18 * s)
    cv2.putText(img, f"t={t:.1f}s  tracks {len(res.tracks)}  {getattr(pipe.detector, 'name', '')}", (8, img.shape[0] - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45 * s, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def process_video(video: Path, cfg: PipelineConfig, cal: Calibration | None, detector=None, max_frames: int | None = None,
                  save_video: Path | None = None, show: bool = False) -> dict:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise FileNotFoundError(f"видео не открывается: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    pipe = Pipeline(cfg, cal, detector=detector or BackgroundDetector())
    n = 0
    per_frame_vehicles = []
    writer = None
    recent: list = []  # события последних 3 с для подписи на кадре
    try:
        while max_frames is None or n < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if cal is not None and (frame.shape[1], frame.shape[0]) != tuple(cal.image_size):
                raise ValueError(f"размер кадра {frame.shape[1]}×{frame.shape[0]} не совпадает с калибровкой {cal.image_size}")
            res = pipe.process(n / fps, frame)
            per_frame_vehicles.append(len(res.tracks))
            if save_video or show:
                t = n / fps
                recent = [(te, e) for te, e in recent if t - te < 3.0] + [(t, e) for e in res.events]
                img = draw(frame, res, pipe, t, recent)
                if save_video:
                    if writer is None:
                        writer = cv2.VideoWriter(str(save_video), cv2.VideoWriter_fourcc(*"mp4v"), fps, (img.shape[1], img.shape[0]))
                    writer.write(img)
                if show:
                    try:
                        cv2.imshow("SmartFlow CV (q - выход)", img)
                        if cv2.waitKey(max(1, int(1000 / fps))) & 0xFF == ord("q"):
                            break
                    except cv2.error as e:
                        raise ModuleUnavailable("окно не открывается: установлен OpenCV без поддержки окон "
                                                "(pip install opencv-python) — используйте --save-video") from e
            n += 1
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        if show:
            try:
                cv2.destroyAllWindows()
            except cv2.error:
                pass
    s = pipe.summary()
    return {
        "format": "smartflow-cv-run/1", "source": {"type": "test_video", "file": Path(video).name, "fps": fps, "frames": n},
        "calibration": cal.source if cal else None,
        "modules": pipe.module_status(True),
        "detector": getattr(pipe.detector, "name", type(pipe.detector).__name__),
        "mean_tracked_vehicles": round(sum(per_frame_vehicles) / n, 2) if n else None,
        **s,
        "note": "События предварительные, не юридическое заключение. " + (f"Видео с разметкой записано в {save_video}." if save_video else "Кадры не сохранялись."),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="SmartFlow CV: обработка тестового видео")
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--calibration", type=Path)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--detector", choices=["background", "yolox", "yolo"], default="background")
    ap.add_argument("--save-video", type=Path, help="записать видео с разметкой (.mp4)")
    ap.add_argument("--show", action="store_true", help="показать разметку в окне")
    ap.add_argument("--disable", nargs="*", default=[], choices=MODULES)
    ap.add_argument("--max-frames", type=int)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
        for m in a.disable:
            cfg.enabled[m] = False
        cal = Calibration.load(a.calibration) if a.calibration else None
        if a.detector == "yolox":
            from .detrac_eval import fetch_weights
            from .vehicle_detection import YoloxOnnxDetector
            det = YoloxOnnxDetector(str(fetch_weights(Path.home() / ".cache" / "smartflow-detrac")))
        else:
            det = YoloDetector() if a.detector == "yolo" else None
        out = process_video(a.video, cfg, cal, det, a.max_frames, a.save_video, a.show)
    except (FileNotFoundError, ValueError, ModuleUnavailable, OSError) as e:
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
