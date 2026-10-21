"""Конвейер камеры: модули включаются и выключаются независимо, каждый сообщает свой статус.

Статусы модуля: off (выключен), ok (работает), no_calibration (нужна калибровка), no_frame (нет кадра
от камеры), unavailable (нет модели/зависимости), insufficient_data. Если модуль не может дать число,
он даёт статус, а не ноль. На выходе — агрегированные метрики и анонимные события; кадры не сохраняются.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .calibration import Calibration
from .lane_crossing_detection import CrossingEvent, GroundLine, LineCrossingDetector
from .seatbelt_assessment import SeatbeltAssessor
from .speed_estimation import SpeedEstimate, check_limit, estimate_speed
from .traffic_density_estimation import DensityEstimator, DensitySnapshot, Zone
from .vehicle_detection import BackgroundDetector, Detection
from .vehicle_tracking import Tracker

MODULES = ("vehicle_detection", "vehicle_tracking", "speed_estimation", "seatbelt_assessment", "lane_crossing_detection",
           "traffic_density_estimation")


@dataclass
class PipelineConfig:
    enabled: dict[str, bool] = field(default_factory=lambda: {m: True for m in MODULES})
    speed_limit_kmh: float = 60.0
    speed_tolerance_kmh: float = 5.0
    min_confidence: float = 0.6
    solid_line: GroundLine | None = None
    zone: Zone | None = None

    def on(self, m: str) -> bool:
        return self.enabled.get(m, False)


@dataclass
class FrameResult:
    t: float
    status: dict[str, str]
    detections: list[Detection]
    tracks: list[dict]  # анонимные: номер, рамка, точка на дороге, скорость
    density: DensitySnapshot | None
    events: list[dict]


class Pipeline:
    def __init__(self, config: PipelineConfig, calibration: Calibration | None = None, detector=None, seatbelt: SeatbeltAssessor | None = None):
        self.cfg = config
        self.cal = calibration
        self.detector = detector or BackgroundDetector()
        self.tracker = Tracker()
        self.crossing = LineCrossingDetector(config.solid_line) if config.solid_line else None
        self.density = DensityEstimator(config.zone) if config.zone else None
        self.seatbelt = seatbelt or SeatbeltAssessor()
        self.events: list[dict] = []
        self.frames = 0
        self.missing_frames = 0
        self._speed_counts = {"ok": 0, "no_calibration": 0, "insufficient_data": 0}
        self._last_live: set[int] = set()

    def module_status(self, frame_ok: bool) -> dict[str, str]:
        st = {}
        for m in MODULES:
            if not self.cfg.on(m):
                st[m] = "off"
            elif not frame_ok:
                st[m] = "no_frame"
            elif m in ("vehicle_tracking", "speed_estimation", "lane_crossing_detection", "traffic_density_estimation") and not self.cfg.on("vehicle_detection"):
                st[m] = "off"  # без детекции нечего сопровождать
            elif m in ("speed_estimation", "lane_crossing_detection") and not self.cfg.on("vehicle_tracking"):
                st[m] = "off"
            elif m in ("speed_estimation", "lane_crossing_detection") and self.cal is None:
                st[m] = "no_calibration"
            elif m == "lane_crossing_detection" and self.crossing is None:
                st[m] = "insufficient_data"  # линия не задана
            elif m == "seatbelt_assessment" and not self.seatbelt.available:
                st[m] = "unavailable"
            else:
                st[m] = "ok"
        return st

    def process(self, t: float, frame: np.ndarray | None) -> FrameResult:
        ok = frame is not None and getattr(frame, "size", 0) > 0
        self.frames += 1
        st = self.module_status(ok)
        if not ok:
            self.missing_frames += 1
            return FrameResult(t, st, [], [], None, [])
        dets = self.detector.detect(frame) if st["vehicle_detection"] == "ok" else []
        to_ground = self.cal.to_ground if self.cal is not None else None
        self.tracker.frame_h = frame.shape[0]
        tracks = self.tracker.update(t, dets, to_ground) if st["vehicle_tracking"] == "ok" else []
        events: list[dict] = []
        out_tracks = []
        pts = []
        m_per_px = None
        for tr in tracks:
            _, u, v, x, y = tr.history[-1]
            sp = SpeedEstimate("off")
            if st["speed_estimation"] == "ok":
                if self.cal is not None:
                    m_per_px = self.cal.meters_per_pixel([u, v])
                sp = estimate_speed(tr.history, calibrated=self.cal is not None, m_per_px=m_per_px)
                self._speed_counts[sp.status] = self._speed_counts.get(sp.status, 0) + 1
                chk = check_limit(sp, self.cfg.speed_limit_kmh, self.cfg.speed_tolerance_kmh, self.cfg.min_confidence)
                if chk.status == "over" and not getattr(tr, "_speed_flagged", False):
                    tr._speed_flagged = True  # одно событие на трек
                    events.append({"type": "speed_over_limit", "t": round(t, 2), "track": tr.tid, "speed_kmh": sp.speed_kmh,
                                   "limit_kmh": self.cfg.speed_limit_kmh, "confidence": sp.confidence, "heading_deg": sp.heading_deg,
                                   "status": "предварительное"})
            if st["lane_crossing_detection"] == "ok":
                ev = self.crossing.update(tr.tid, t, x, y, quality=min(1.0, tr.hits / 10))
                if ev:
                    events.append(_crossing_dict(ev))
            out_tracks.append({"track": tr.tid, "box": [round(c, 1) for c in tr.box], "x": _r(x), "y": _r(y),
                               "speed_kmh": sp.speed_kmh if sp.status == "ok" else None, "speed_status": sp.status})
            pts.append((tr.tid, x, y, sp.speed_kmh if sp.status == "ok" else None))
        if self.crossing is not None and st["lane_crossing_detection"] == "ok":
            live = {tr.tid for tr in self.tracker.tracks}
            for tid in self._last_live - live:
                ev = self.crossing.lost(tid, t)
                if ev:
                    events.append(_crossing_dict(ev))
            self._last_live = live
        dens = None
        if st["traffic_density_estimation"] == "ok" and self.density is not None:
            dens = self.density.update(t, pts, self.cal is not None, len(dets))
        self.events += events
        return FrameResult(t, st, dets, out_tracks, dens, events)

    def summary(self) -> dict:
        """Итог прогона: агрегаты и анонимные события; метрики без данных — None."""
        return {
            "frames": self.frames, "missing_frames": self.missing_frames,
            "speed_estimates": dict(self._speed_counts),
            "flow_veh_h": self.density.flow_veh_h() if self.density and self.cal is not None else None,
            "events": list(self.events),
        }


def _r(v: float) -> float | None:
    return round(float(v), 2) if np.isfinite(v) else None


def _crossing_dict(ev: CrossingEvent) -> dict:
    return {"type": "solid_line_crossing" if ev.status == "potential_violation" else "solid_line_insufficient_data", "t": ev.t,
            "track": ev.track, "line": ev.line, "direction": ev.direction, "x": ev.x, "y": ev.y, "depth_m": ev.depth_m,
            "confidence": ev.confidence, "status": "предварительное" if ev.status == "potential_violation" else "недостаточно данных"}
