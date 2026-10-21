"""Трекер, ремень, конвейер целиком (на короткой синтетической сцене), тестовое видео, отказ камеры."""
import json
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from smartflow_cv import synthetic as syn
from smartflow_cv.evaluate import make_config, road_mask
from smartflow_cv.pipeline import MODULES, Pipeline, PipelineConfig
from smartflow_cv.run import process_video
from smartflow_cv.seatbelt_assessment import BUCKLED, UNBUCKLED, UNKNOWN, SeatbeltAssessor
from smartflow_cv.vehicle_detection import BackgroundDetector, Detection, ModuleUnavailable, YoloDetector
from smartflow_cv.vehicle_tracking import Tracker

ROOT = Path(__file__).resolve().parents[1]


class TrackerTests(unittest.TestCase):
    def test_ids_stable_through_short_gap(self):
        tr = Tracker()
        ids = []
        for i in range(30):
            dets = [Detection((100 + 5 * i, 100, 140 + 5 * i, 130), 0.9), Detection((400 - 4 * i, 300, 450 - 4 * i, 340), 0.9)]
            if 12 <= i <= 13:
                dets = dets[1:]  # первую машину не нашли два кадра
            out = tr.update(i * 0.04, dets)
            ids.append(sorted(t.tid for t in out))
        self.assertEqual(ids[-1], [1, 2], "номера анонимные и не меняются после пропуска")
        self.assertTrue(all(isinstance(t, int) for t in ids[-1]))

    def test_lost_track_ends(self):
        tr = Tracker(max_age_s=0.2)
        for i in range(5):
            tr.update(i * 0.04, [Detection((10, 10, 40, 40), 0.9)])
        tr.update(1.0, [])
        self.assertEqual(tr.tracks, [])
        self.assertEqual(len(tr.ended), 1)


class StubModel:
    name, validated_on = "заглушка для тестов", None

    def __init__(self, p):
        self.p = p

    def __call__(self, crop):
        return self.p


def cabin(size=160, blur=False, glare=False):
    rng = np.random.default_rng(0)
    img = rng.integers(0, 255, (size, size, 3), dtype=np.uint8)  # текстура = резкое изображение
    if blur:
        img = cv2.GaussianBlur(img, (31, 31), 12)
    if glare:
        img[: size // 2] = 255
    return img


class SeatbeltTests(unittest.TestCase):
    def test_without_model_always_unknown(self):
        r = SeatbeltAssessor().assess(cabin())
        self.assertEqual(r.label, UNKNOWN)
        self.assertIn("не подключена", r.reason)
        self.assertIsNone(r.confidence)

    def test_quality_gate_before_model(self):
        a = SeatbeltAssessor(StubModel(0.01))  # модель «уверена», что не пристёгнут, но кадр плохой
        for crop in (cabin(40), cabin(blur=True), cabin(glare=True), None):
            self.assertEqual(a.assess(crop).label, UNKNOWN)

    def test_thresholds(self):
        self.assertEqual(SeatbeltAssessor(StubModel(0.95)).assess(cabin()).label, BUCKLED)
        self.assertEqual(SeatbeltAssessor(StubModel(0.05)).assess(cabin()).label, UNBUCKLED)
        self.assertEqual(SeatbeltAssessor(StubModel(0.55)).assess(cabin()).label, UNKNOWN)
        self.assertEqual(SeatbeltAssessor(StubModel(float("nan"))).assess(cabin()).label, UNKNOWN)


class PipelineTests(unittest.TestCase):
    """Короткая синтетическая сцена: 30 с, известная «правда»."""

    @classmethod
    def setUpClass(cls):
        cls.sc = syn.Scenario(seed=3, duration=30.0)
        cls.frames = list(syn.frames(cls.sc))

    def run_pipe(self, cal=True, enabled=None, frames=None):
        cfg = make_config()
        if enabled:
            cfg.enabled.update(enabled)
        pipe = Pipeline(cfg, self.sc.camera.calibration() if cal else None, detector=BackgroundDetector(roi=road_mask(self.sc)))
        res = [pipe.process(t, f) for t, f, _ in (frames or self.frames)]
        return pipe, res

    def test_speeds_close_to_truth(self):
        _, res = self.run_pipe()
        errs = []
        for (t, _, gt), r in zip(self.frames, res):
            for tr in r.tracks:
                if tr["speed_kmh"] is None:
                    continue
                g = max(gt.vehicles, key=lambda g: _iou(tr["box"], g.box), default=None)
                if g is not None and _iou(tr["box"], g.box) > 0.6 and g.v > 1:
                    errs.append(abs(tr["speed_kmh"] - g.v * 3.6))
        self.assertGreater(len(errs), 200)
        self.assertLess(float(np.median(errs)), 3.0)

    def test_no_calibration_means_no_numbers(self):
        pipe, res = self.run_pipe(cal=False)
        st = res[-1].status
        self.assertEqual(st["speed_estimation"], "no_calibration")
        self.assertEqual(st["lane_crossing_detection"], "no_calibration")
        self.assertTrue(all(tr["speed_kmh"] is None and tr["x"] is None for r in res for tr in r.tracks))
        self.assertTrue(any(r.tracks for r in res), "детекция и треки без калибровки работают")
        s = pipe.summary()
        self.assertIsNone(s["flow_veh_h"])
        self.assertFalse([e for e in s["events"] if e["type"] in ("speed_over_limit", "solid_line_crossing")])

    def test_modules_switch_off_independently(self):
        _, res = self.run_pipe(enabled={"speed_estimation": False})
        self.assertEqual(res[-1].status["speed_estimation"], "off")
        self.assertEqual(res[-1].status["lane_crossing_detection"], "ok")
        self.assertTrue(all(tr["speed_kmh"] is None for r in res for tr in r.tracks))
        _, res = self.run_pipe(enabled={"vehicle_detection": False}, frames=self.frames[:50])
        self.assertTrue(all(res[-1].status[m] == "off" for m in MODULES if m != "seatbelt_assessment"))
        self.assertEqual(res[-1].tracks, [])
        self.assertEqual(res[-1].status["seatbelt_assessment"], "unavailable")

    def test_camera_dropout(self):
        frames = [(t, None if 10 <= t < 12 else f, g) for t, f, g in self.frames]
        pipe, res = self.run_pipe(frames=frames)
        gap = [r for r in res if 10 <= r.t < 12]
        self.assertTrue(all(set(r.status.values()) == {"no_frame"} or "off" in r.status.values() for r in gap))
        self.assertTrue(all(r.tracks == [] and r.density is None for r in gap), "без кадра — никаких выдуманных показателей")
        self.assertEqual(pipe.summary()["missing_frames"], 50)
        self.assertTrue(res[-1].tracks, "после восстановления камеры сопровождение продолжается")

    def test_events_are_anonymous_and_preliminary(self):
        pipe, _ = self.run_pipe()
        for e in pipe.summary()["events"]:
            self.assertIn(e["status"], ("предварительное", "недостаточно данных"))
            self.assertIsInstance(e["track"], int)
            self.assertFalse({"image", "frame", "plate", "face"} & set(e))


class VideoTests(unittest.TestCase):
    def test_recorded_video_and_errors(self):
        tmp = Path(tempfile.mkdtemp())
        demo = syn.write_demo(tmp, seconds=12.0, seed=4)
        sc = syn.Scenario(seed=4)
        out = process_video(Path(demo["video"]), make_config(), sc.camera.calibration())
        self.assertEqual(out["source"]["frames"], 300)
        self.assertEqual(out["source"]["type"], "test_video")
        self.assertGreater(out["mean_tracked_vehicles"], 0.5)
        # командная строка с файлами калибровки и настройки камеры
        res = tmp / "events.json"
        r = subprocess.run([sys.executable, "-m", "smartflow_cv.run", "--video", demo["video"], "--calibration", demo["calibration"],
                            "--config", demo["config"], "--disable", "seatbelt_assessment", "--out", str(res)], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(res.read_text(encoding="utf-8"))
        self.assertEqual(d["modules"]["seatbelt_assessment"], "off")
        self.assertEqual(d["modules"]["speed_estimation"], "ok")
        self.assertGreater(d["speed_estimates"]["ok"], 0)
        # калибровка от другого размера кадра и отсутствующее видео — понятная ошибка, а не неверные метры
        cal = tmp / "cal.json"
        cal.write_text(json.dumps(sc.camera.calibration(0.5).to_json()))
        r = subprocess.run([sys.executable, "-m", "smartflow_cv.run", "--video", demo["video"], "--calibration", str(cal)], cwd=ROOT,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("не совпадает с калибровкой", r.stderr)
        r = subprocess.run([sys.executable, "-m", "smartflow_cv.run", "--video", str(tmp / "нет.mp4")], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("не открывается", r.stderr)

    def test_yolo_adapter_reports_missing_dependency(self):
        try:
            import ultralytics  # noqa: F401
        except ImportError:
            with self.assertRaises(ModuleUnavailable):
                YoloDetector()
        else:  # pragma: no cover
            self.skipTest("ultralytics установлен — адаптер не проверяется в этом тесте")


def _iou(a, b):
    from smartflow_cv.vehicle_tracking import iou
    return iou(a, b)


if __name__ == "__main__":
    unittest.main()
