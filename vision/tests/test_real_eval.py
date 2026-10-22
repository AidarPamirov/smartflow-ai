"""Проверка на реальном видео (detrac_eval.py): сопоставление рамок, счёт на линии, маска дороги — без сети."""
import tempfile
import unittest
from pathlib import Path

from smartflow_cv.detrac_eval import crossings, load_gt, match, road_mask, score
from smartflow_cv.vehicle_detection import Detection, ModuleUnavailable, YoloxOnnxDetector

CSV = """,filename,width,height,class,xmin,ymin,xmax,ymax,confidence,target_id
0,image000001.jpg,960,540,vehicle,100,100,200,180,1.0,1
1,image000001.jpg,960,540,ignored,800,0,960,100,1.0,-1
2,image000002.jpg,960,540,vehicle,100,300,200,380,1.0,1
3,image000002.jpg,960,540,vehicle,500,100,600,180,1.0,2
"""


class MatchTests(unittest.TestCase):
    def test_greedy_match_counts(self):
        gts = [(0, 0, 10, 10), (20, 20, 30, 30)]
        dets = [(0, 0, 10, 10), (21, 21, 31, 31), (100, 100, 110, 110)]
        tp, fp, fn, fp_idx = match(dets, gts, 0.5)
        self.assertEqual((tp, fp, fn, fp_idx), (2, 1, 0, [2]))

    def test_one_detection_cannot_match_two_cars(self):
        gts = [(0, 0, 10, 10), (0, 0, 10, 10)]
        tp, fp, fn, _ = match([(0, 0, 10, 10)], gts, 0.5)
        self.assertEqual((tp, fp, fn), (1, 0, 1))

    def test_iou_threshold(self):
        tp, fp, fn, _ = match([(0, 0, 10, 10)], [(5, 0, 15, 10)], 0.5)  # IoU = 1/3
        self.assertEqual((tp, fp, fn), (0, 1, 1))
        tp, _, _, _ = match([(0, 0, 10, 10)], [(5, 0, 15, 10)], 0.3)
        self.assertEqual(tp, 1)


class CountTests(unittest.TestCase):
    def test_crossing_counted_once_per_track(self):
        tracks = {1: [(1, 100.0), (2, 200.0), (3, 400.0)], 2: [(1, 10.0), (2, 20.0)], 3: [(1, 400.0), (2, 300.0), (3, 290.0)]}
        self.assertEqual(crossings(tracks, 324.0), 2)  # вниз и вверх, третий трек линию не пересёк

    def test_gt_and_mask_from_csv(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "annotations.csv"
            p.write_text(CSV, encoding="utf-8")
            cars, ign = load_gt(p, 2)
            self.assertEqual(len(cars[1]), 1)
            self.assertEqual(len(cars[2]), 2)
            self.assertEqual(len(ign[1]), 1)
            m = road_mask(p, (960, 540), grow=0)
            self.assertEqual(m[140, 150], 255)  # внутри размеченной машины
            self.assertEqual(m[50, 900], 0)  # игнорируемая область в маску дороги не входит
            self.assertEqual(m[500, 900], 0)

    def test_score_perfect_detector(self):
        """Детектор, выдающий ровно разметку, получает точность и полноту 1 (кадры после разогрева)."""
        cars = {k: [((100, 10 + 20 * k, 200, 90 + 20 * k), 1)] for k in range(1, 31)}
        dets = [[Detection(b, 1.0) for b, _ in cars[k]] for k in range(1, 31)]
        r = score(dets, cars, {}, None, 540, 30)
        self.assertEqual((r["iou05"]["precision"], r["iou05"]["recall"]), (1.0, 1.0))
        self.assertEqual(r["merged_fp"], 0)
        self.assertEqual((r["count_gt"], r["count_ours"]), (1, 1))  # линия на 324 px пересечена один раз


class YoloxTests(unittest.TestCase):
    def test_missing_weights_reports_unavailable(self):
        with self.assertRaises(ModuleUnavailable):
            YoloxOnnxDetector("/нет/такого/файла.onnx")



class PrimeTests(unittest.TestCase):
    def test_primed_background_detects_from_first_frame(self):
        import numpy as np
        from smartflow_cv.vehicle_detection import BackgroundDetector
        bg = np.full((120, 160, 3), 90, np.uint8)
        d = BackgroundDetector()
        d.prime([bg] * 5)
        f = bg.copy()
        f[40:80, 50:100] = (20, 200, 30)
        dets = d.detect(f)
        self.assertEqual(len(dets), 1)
        x0, _, _, y1 = dets[0].box
        self.assertLessEqual(abs(x0 - 50), 3)
        self.assertLessEqual(abs(y1 - 80), 3)


class AnnotatedVideoTests(unittest.TestCase):
    def test_save_video_writes_annotated_frames(self):
        import cv2
        from smartflow_cv.calibration import Calibration
        from smartflow_cv.run import load_config, process_video
        from smartflow_cv.synthetic import write_demo
        with tempfile.TemporaryDirectory() as d:
            files = write_demo(d, seconds=2.0)
            out = Path(d) / "annotated.mp4"
            r = process_video(Path(files["video"]), load_config(Path(files["config"])), Calibration.load(Path(files["calibration"])),
                              save_video=out)
            cap = cv2.VideoCapture(str(out))
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
            self.assertEqual(n, r["source"]["frames"])
            self.assertIn("записано", r["note"])


if __name__ == "__main__":
    unittest.main()
