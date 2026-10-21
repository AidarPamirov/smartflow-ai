"""Калибровка (пиксели ↔ метры), скорость, пересечение линии, плотность — без видео."""
import math
import random
import unittest

import numpy as np

from smartflow_cv.calibration import Calibration, CalibrationError
from smartflow_cv.lane_crossing_detection import GroundLine, LineCrossingDetector
from smartflow_cv.speed_estimation import SpeedEstimate, check_limit, estimate_speed
from smartflow_cv.synthetic import CameraModel
from smartflow_cv.traffic_density_estimation import DensityEstimator, Zone


class CalibrationTests(unittest.TestCase):
    cam = CameraModel()

    def test_points_recover_exact_homography(self):
        exact = self.cam.calibration()
        ground = [(10, 0), (10, 10.5), (40, 0), (40, 10.5), (25, 5.25), (15, 3.5)]
        px = exact.to_image(ground).tolist()
        cal = Calibration.from_points(ground, px, exact.image_size)
        self.assertLess(cal.reprojection_error_px, 1e-6)
        probe = np.array([[12.0, 1.0], [33.3, 9.1], [48.0, 4.0]])
        np.testing.assert_allclose(cal.to_ground(exact.to_image(probe)), probe, atol=1e-6)

    def test_round_trip_and_json(self):
        cal = self.cam.calibration()
        pts = np.array([[11.0, 2.0], [30.0, 7.0], [55.0, 10.0]])
        np.testing.assert_allclose(cal.to_ground(cal.to_image(pts)), pts, atol=1e-9)
        again = Calibration.from_json(cal.to_json())
        np.testing.assert_allclose(again.to_image(pts), cal.to_image(pts), atol=1e-9)

    def test_sky_and_behind_camera_are_nan(self):
        cal = self.cam.calibration()
        self.assertTrue(np.isnan(cal.to_ground([[480, 0]])).all() or cal.to_ground([[480, 0]])[0, 0] > 60)
        horizon_v = self.cam.project(np.array([[1e6, 5.25, 0.0]]))[0, 1]
        self.assertTrue(np.isnan(cal.to_ground([[480, horizon_v - 20]])).all(), "над горизонтом нет дороги")
        self.assertTrue(np.isnan(cal.to_image([[-20.0, 5.0]])).all(), "точка позади камеры")

    def test_scale_grows_with_distance(self):
        cal = self.cam.calibration()
        near = cal.meters_per_pixel(cal.to_image([[12, 5.25]])[0])
        far = cal.meters_per_pixel(cal.to_image([[50, 5.25]])[0])
        self.assertGreater(far, 3 * near)

    def test_bad_input_rejected(self):
        with self.assertRaises(CalibrationError):
            Calibration.from_points([(0, 0), (1, 0), (2, 0)], [(0, 0), (1, 1), (2, 2)], (100, 100))
        with self.assertRaises(CalibrationError):
            Calibration.from_points([(0, 0), (1, 0), (2, 0), (3, 0)], [(0, 0), (1, 1), (2, 2), (3, 5)], (100, 100))
        with self.assertRaises(CalibrationError):
            Calibration(np.zeros((3, 3)), (100, 100))


def track(points, dt=0.04, noise=0.0, seed=0):
    rng = random.Random(seed)
    return [(i * dt, 0.0, 0.0, x + rng.gauss(0, noise), y + rng.gauss(0, noise)) for i, (x, y) in enumerate(points)]


class SpeedTests(unittest.TestCase):
    def test_constant_speed(self):
        h = track([(10 + 15 * 0.04 * i, 5.0) for i in range(40)], noise=0.05)
        e = estimate_speed(h, calibrated=True)
        self.assertEqual(e.status, "ok")
        self.assertAlmostEqual(e.speed_kmh, 54.0, delta=1.0)
        self.assertAlmostEqual(e.heading_deg, 0.0, delta=3.0)
        self.assertGreater(e.confidence, 0.8)

    def test_diagonal_and_stopped(self):
        h = track([(10 + 6 * 0.04 * i, 2 + 8 * 0.04 * i) for i in range(30)])
        self.assertAlmostEqual(estimate_speed(h, True).speed_kmh, 36.0, delta=0.1)
        self.assertAlmostEqual(estimate_speed(track([(20.0, 3.0)] * 30), True).speed_kmh, 0.0, delta=0.01)

    def test_no_numbers_without_calibration_or_history(self):
        h = track([(10 + 0.6 * i, 5.0) for i in range(40)])
        self.assertEqual(estimate_speed(h, calibrated=False), SpeedEstimate("no_calibration"))
        self.assertEqual(estimate_speed(h[:5], True).status, "insufficient_data")
        self.assertEqual(estimate_speed([], True).status, "insufficient_data")
        nan = [(t, u, v, float("nan"), float("nan")) for t, u, v, _, _ in h]
        self.assertEqual(estimate_speed(nan, True).status, "insufficient_data")

    def test_limit_check(self):
        self.assertEqual(check_limit(SpeedEstimate("ok", 72.0, 0, 0.9, 1.0), 60, 5).status, "over")
        self.assertEqual(check_limit(SpeedEstimate("ok", 63.0, 0, 0.9, 1.0), 60, 5).status, "within")
        self.assertEqual(check_limit(SpeedEstimate("ok", 90.0, 0, 0.3, 1.0), 60, 5).status, "unknown", "низкая уверенность")
        self.assertEqual(check_limit(SpeedEstimate("no_calibration"), 60).status, "unknown")


class LineCrossingTests(unittest.TestCase):
    line = GroundLine((20.0, 3.5), (40.0, 3.5))

    def run_path(self, pts, det=None):
        det = det or LineCrossingDetector(self.line)
        evs = [det.update(1, i * 0.1, x, y) for i, (x, y) in enumerate(pts)]
        return [e for e in evs if e], det

    def lane_change(self, x0, y0, y1, n=40):
        return [(x0 + 0.4 * i, y0 + (y1 - y0) * (1 - math.cos(math.pi * min(1, max(0, (i - 5) / 25)))) / 2) for i in range(n)]

    def test_clear_crossing(self):
        ev, _ = self.run_path(self.lane_change(22, 5.25, 1.75))
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0].status, "potential_violation")
        self.assertTrue(20 <= ev[0].x <= 40)
        ev2, _ = self.run_path(self.lane_change(22, 1.75, 5.25))
        self.assertNotEqual(ev[0].direction, ev2[0].direction)

    def test_shallow_wiggle_and_return_are_not_violations(self):
        ev, _ = self.run_path([(22 + 0.4 * i, 5.25 - 2.0 * math.sin(math.pi * i / 30)) for i in range(31)])  # заехал на 0,25 м
        self.assertEqual(ev, [])
        ev, _ = self.run_path([(22 + 0.4 * i, 5.25 - 2.3 * math.sin(math.pi * i / 30)) for i in range(31)])  # 0,55 м: в полосе допуска
        self.assertEqual(ev, [])
        ev, _ = self.run_path([(22 + 0.4 * i, 5.25 - 3.0 * math.sin(math.pi * i / 30)) for i in range(31)])  # 1,25 м и вернулся
        self.assertEqual(len(ev), 1, "заезд за линию и возврат — одно событие, а не два")

    def test_outside_segment_and_edge(self):
        ev, _ = self.run_path(self.lane_change(36, 5.25, 1.75))
        self.assertEqual(ev, [], "пересечение продолжения линии (прерывистая) — не нарушение")
        det = LineCrossingDetector(GroundLine((20.0, 3.5), (40.0, 3.5)), edge_margin=0.05)
        ev, _ = self.run_path(self.lane_change(32.5, 5.25, 1.75), det)
        self.assertEqual([e.status for e in ev], ["insufficient_data"], "у самого края линии")

    def test_jump_of_merged_box_is_not_a_violation(self):
        """Две машины слились в одно пятно: точка трека скачком сместилась через линию — это не манёвр."""
        pts = [(22 + 0.6 * i, 5.25) for i in range(10)] + [(28 + 0.6 * i, 2.6) for i in range(10)]
        ev, _ = self.run_path(pts)
        self.assertEqual([e.status for e in ev], ["insufficient_data"])

    def test_lost_on_line_and_nan(self):
        det = LineCrossingDetector(self.line)
        for i, (x, y) in enumerate(self.lane_change(22, 5.25, 1.75, n=19)):
            det.update(7, i * 0.1, x, y)
        det.update(7, 2.0, float("nan"), float("nan"))
        ev = det.lost(7, 2.1)
        self.assertIsNotNone(ev)
        self.assertEqual(ev.status, "insufficient_data")


class DensityTests(unittest.TestCase):
    zone = Zone(10, 50, ((0, 3.5), (3.5, 7.0)), stop_x=50, count_x=25)

    def test_queue_density_and_count(self):
        d = DensityEstimator(self.zone)
        # полоса 0: очередь из трёх стоящих машин от стоп-линии, четвёртая стоит отдельно далеко
        pts = [(1, 47.0, 1.7, 0.0), (2, 40.0, 1.7, 0.0), (3, 33.0, 1.7, 1.0), (4, 12.0, 1.7, 0.0), (5, 30.0, 5.2, 40.0)]
        s = d.update(0.0, pts, True, 5)
        self.assertEqual(s.per_lane, (4, 1))
        self.assertEqual(s.queue_m, (17.0, 0.0))
        self.assertAlmostEqual(s.density_veh_km_lane, 5 / 0.04 / 2)
        d.update(0.1, [(5, 24.0, 5.2, 40.0)], True, 1)
        d.update(0.2, [(5, 26.0, 5.2, 40.0)], True, 1)
        self.assertEqual(d.counted, 1)
        self.assertIsNone(d.flow_veh_h(), "меньше 30 с наблюдения — поток не оценивается")

    def test_no_calibration(self):
        s = DensityEstimator(self.zone).update(0.0, [], False, 3)
        self.assertEqual((s.status, s.vehicles_in_frame, s.per_lane, s.queue_m), ("no_calibration", 3, None, None))


if __name__ == "__main__":
    unittest.main()
