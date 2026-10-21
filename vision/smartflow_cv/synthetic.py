"""Синтетическая сцена с известной «правдой» для проверки модулей компьютерного зрения.

Это не видео с улиц Бишкека и не имитация реальной камеры. Это прямой участок дороги из трёх полос,
неподвижная камера на высоте 12 м и машины-параллелепипеды, которые едут по модели IDM, стоят на красный
и иногда перестраиваются (в том числе через сплошную линию). Для каждого кадра известны точные рамки машин,
их положение на дороге, скорость и все пересечения сплошной линии — по ним считаются ошибки модулей.

Координаты дороги: x — вдоль движения (м), y — поперёк, вправо по ходу (м), z — вверх.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

import cv2
import numpy as np

from .calibration import Calibration

LANE_W = 3.5
N_LANES = 3
SOLID = (18.0, 38.0)  # сплошная линия между полосами 0 и 1 (y = 3,5 м) на этом отрезке x
STOP_X = 50.0  # стоп-линия
VEH_L, VEH_W, VEH_H = 4.5, 1.8, 1.45


@dataclass(frozen=True)
class CameraModel:
    """Камера-обскура над дорогой. Из неё получается точная гомография плоскости дороги."""

    x: float = -6.0
    y: float = 5.25
    height: float = 12.0
    pitch_deg: float = 24.0
    focal_px: float = 1100.0
    width: int = 960
    height_px: int = 540

    def _krm(self):
        th = math.radians(self.pitch_deg)
        r = np.array([0.0, 1.0, 0.0])
        d = np.array([-math.sin(th), 0.0, -math.cos(th)])
        f = np.array([math.cos(th), 0.0, -math.sin(th)])
        R = np.vstack([r, d, f])
        K = np.array([[self.focal_px, 0, self.width / 2], [0, self.focal_px, self.height_px / 2], [0, 0, 1.0]])
        return K, R, np.array([self.x, self.y, self.height])

    def project(self, pts3: np.ndarray) -> np.ndarray:
        """Точки (N×3, метры) → пиксели (N×2); точки за камерой → NaN."""
        K, R, C = self._krm()
        cam = (np.asarray(pts3, dtype=float) - C) @ R.T
        out = np.full((len(cam), 2), np.nan)
        ok = cam[:, 2] > 0.1
        uvw = cam[ok] @ K.T
        out[ok] = uvw[:, :2] / uvw[:, 2:3]
        return out

    def calibration(self, scale: float = 1.0) -> Calibration:
        """Точная калибровка (для синтетики известна заранее). scale — если кадр уменьшен."""
        K, R, C = self._krm()
        M = np.array([[1.0, 0, -C[0]], [0, 1.0, -C[1]], [0, 0, -C[2]]])
        H = np.diag([scale, scale, 1.0]) @ K @ R @ M
        return Calibration(H / H[2, 2], (round(self.width * scale), round(self.height_px * scale)), source="synthetic-exact")


@dataclass
class Vehicle:
    vid: int
    x: float  # центр, м
    y: float
    v: float
    v0: float  # желаемая скорость
    lane: int
    color: tuple[int, int, int]
    change_at: float | None = None  # x начала перестроения
    change_to: int | None = None
    change_from_y: float = 0.0
    change_t0: float | None = None
    crossed: list = field(default_factory=list)


@dataclass
class Scenario:
    seed: int = 1
    duration: float = 90.0
    fps: float = 25.0
    flow_veh_h_per_lane: float = 800.0
    red_s: float = 30.0
    green_s: float = 25.0
    first_red_at: float = 20.0
    change_share: float = 0.5  # доля машин средней полосы, которые перестраиваются влево
    violation_share: float = 0.5  # из них — через сплошную
    noise_sigma: float = 3.0
    flicker: float = 0.0  # амплитуда колебаний яркости
    scale: float = 1.0  # уменьшение разрешения кадра
    dropout: tuple[float, float] | None = None  # интервал без кадров (камера недоступна), с
    camera: CameraModel = CameraModel()


@dataclass
class GTVehicle:
    vid: int
    box: tuple[float, float, float, float]  # x0, y0, x1, y1 в пикселях
    visible: float  # доля видимой площади (0…1) с учётом заслонения
    x: float
    y: float
    v: float


@dataclass
class GTFrame:
    t: float
    vehicles: list[GTVehicle]
    signal_red: bool


def _signal_red(sc: Scenario, t: float) -> bool:
    if t < sc.first_red_at:
        return False
    u = (t - sc.first_red_at) % (sc.red_s + sc.green_s)
    return u < sc.red_s


def _lane_center(k: int) -> float:
    return LANE_W * (k + 0.5)


def simulate(sc: Scenario):
    """Генератор (t, машины, красный ли сигнал) с шагом 1/fps. Детерминирован по seed."""
    rng = random.Random(sc.seed)
    dt = 1.0 / sc.fps
    vehicles: list[Vehicle] = []
    next_spawn = [rng.expovariate(sc.flow_veh_h_per_lane / 3600) + 0.8 for _ in range(N_LANES)]
    vid = 0
    palette = [(200, 200, 205), (40, 40, 45), (170, 30, 30), (30, 60, 150), (230, 230, 230), (120, 120, 125), (30, 110, 60), (200, 160, 40)]
    t = 0.0
    a_max, b, s0, T = 1.6, 2.5, 2.0, 1.3
    while t < sc.duration:
        red = _signal_red(sc, t)
        for k in range(N_LANES):
            if t >= next_spawn[k]:
                lane_veh = [v for v in vehicles if v.lane == k]
                if not lane_veh or min(v.x for v in lane_veh) > -15 + 12:
                    # желаемая скорость ≈ 52 км/ч; каждый восьмой — «торопыга» 70–80 км/ч (для проверки превышения)
                    v0 = rng.uniform(19.5, 22.0) if rng.random() < 0.125 else max(8.0, rng.gauss(14.5, 2.0))
                    veh = Vehicle(vid, -18.0, _lane_center(k), min(v0, 20.0), v0, k, palette[rng.randrange(len(palette))])
                    if k == 1 and rng.random() < sc.change_share:
                        veh.change_to = 0
                        veh.change_at = rng.uniform(19, 33) if rng.random() < sc.violation_share else rng.uniform(2, 10)
                    elif k == 2 and rng.random() < sc.change_share / 2:
                        veh.change_to = 1
                        veh.change_at = rng.uniform(4, 40)
                    vehicles.append(veh)
                    vid += 1
                next_spawn[k] = t + rng.expovariate(sc.flow_veh_h_per_lane / 3600)
        # IDM по полосам
        acc = {}
        for veh in vehicles:
            ahead = [o for o in vehicles if o is not veh and o.lane == veh.lane and o.x > veh.x]
            gap, dv = 1e9, 0.0
            if ahead:
                lead = min(ahead, key=lambda o: o.x)
                gap, dv = lead.x - veh.x - VEH_L, veh.v - lead.v
            front = veh.x + VEH_L / 2
            if red and front < STOP_X and (STOP_X - front) > veh.v ** 2 / (2 * 4.0):
                g2 = STOP_X - front - 0.5
                if g2 < gap:
                    gap, dv = g2, veh.v
            gap = max(gap, 0.1)
            s_star = s0 + veh.v * T + veh.v * dv / (2 * math.sqrt(a_max * b))
            acc[veh.vid] = a_max * (1 - (veh.v / veh.v0) ** 4 - (max(s_star, 0) / gap) ** 2)
        for veh in vehicles:
            veh.v = max(0.0, veh.v + max(acc[veh.vid], -7.0) * dt)
            veh.x += veh.v * dt
            if veh.change_to is not None and veh.change_t0 is None and veh.x >= veh.change_at and veh.v > 2:
                veh.change_t0, veh.change_from_y = t, veh.y
            if veh.change_t0 is not None:
                u = min(1.0, (t - veh.change_t0) / 3.0)
                y_new = veh.change_from_y + (_lane_center(veh.change_to) - veh.change_from_y) * (1 - math.cos(math.pi * u)) / 2
                for line in (LANE_W, 2 * LANE_W):
                    if (veh.y - line) * (y_new - line) < 0:
                        veh.crossed.append((t, veh.x, line))
                veh.y = y_new
                if u >= 0.5:
                    veh.lane = veh.change_to
                if u >= 1.0:
                    veh.change_t0, veh.change_to = None, None
        vehicles = [v for v in vehicles if v.x < 125]
        yield t, vehicles, red
        t = round(t + dt, 6)


def _box3(v: Vehicle) -> np.ndarray:
    x0, x1, y0, y1 = v.x - VEH_L / 2, v.x + VEH_L / 2, v.y - VEH_W / 2, v.y + VEH_W / 2
    return np.array([[x, y, z] for x in (x0, x1) for y in (y0, y1) for z in (0.0, VEH_H)])


def _ground_poly(cam: CameraModel, pts: list[tuple[float, float]]) -> np.ndarray | None:
    p = cam.project(np.array([[x, y, 0.0] for x, y in pts]))
    return None if np.isnan(p).any() else p


class Renderer:
    """Рисует кадры сцены и буфер принадлежности пикселей машинам (для «правды» о заслонении)."""

    def __init__(self, sc: Scenario):
        self.sc = sc
        cam = sc.camera
        rng = np.random.default_rng(sc.seed + 1000)
        img = np.zeros((cam.height_px, cam.width, 3), np.uint8)
        img[:] = (95, 120, 92)  # обочина
        road = _ground_poly(cam, [(-2, -1.0), (400, -1.0), (400, N_LANES * LANE_W + 1.0), (-2, N_LANES * LANE_W + 1.0)])
        cv2.fillPoly(img, [road.astype(np.int32)], (88, 88, 92))
        tex = rng.normal(0, 4, img.shape[:2]).astype(np.float32)
        img = np.clip(img.astype(np.float32) + tex[..., None], 0, 255).astype(np.uint8)
        white = (225, 225, 225)

        def strip(x0, x1, y, w=0.15):
            p = _ground_poly(cam, [(x0, y - w / 2), (x1, y - w / 2), (x1, y + w / 2), (x0, y + w / 2)])
            if p is not None:
                cv2.fillPoly(img, [np.round(p * 8).astype(np.int32)], white, lineType=cv2.LINE_AA, shift=3)

        strip(-2, 400, 0.0)
        strip(-2, 400, N_LANES * LANE_W)
        for k in range(1, N_LANES):
            y = k * LANE_W
            for x in np.arange(-2.0, 400.0, 9.0):
                if k == 1 and x + 3.0 > SOLID[0] and x < SOLID[1]:
                    continue  # на этом отрезке линия сплошная
                strip(x, x + 3.0, y)
            if k == 1:
                strip(SOLID[0], SOLID[1], y)
        p = _ground_poly(cam, [(STOP_X, 0), (STOP_X + 0.4, 0), (STOP_X + 0.4, N_LANES * LANE_W), (STOP_X, N_LANES * LANE_W)])
        cv2.fillPoly(img, [np.round(p * 8).astype(np.int32)], white, lineType=cv2.LINE_AA, shift=3)
        self.background = img

    def render(self, t: float, vehicles: list[Vehicle]) -> tuple[np.ndarray, np.ndarray, dict[int, tuple]]:
        cam = self.sc.camera
        img = self.background.copy()
        ids = np.full(img.shape[:2], -1, np.int32)
        hulls = {}
        for v in sorted(vehicles, key=lambda v: -math.hypot(v.x - cam.x, v.y - cam.y)):  # дальние раньше
            p = cam.project(_box3(v))
            if np.isnan(p).any():
                continue
            hull = cv2.convexHull(np.round(p * 8).astype(np.int32))
            cv2.fillPoly(img, [hull], v.color, lineType=cv2.LINE_AA, shift=3)
            cv2.fillPoly(ids, [cv2.convexHull(np.round(p).astype(np.int32))], int(v.vid))
            # крыша и заднее стекло — темнее, чтобы машина не была однотонным пятном
            top = p[[1, 3, 7, 5]]
            dark = tuple(int(c * 0.75) for c in v.color)
            cv2.fillPoly(img, [np.round(top * 8).astype(np.int32)], dark, lineType=cv2.LINE_AA, shift=3)
            rear = cam.project(np.array([[v.x - VEH_L / 2, v.y - 0.7, 0.95], [v.x - VEH_L / 2, v.y + 0.7, 0.95],
                                         [v.x - VEH_L / 2 + 0.6, v.y + 0.7, 1.4], [v.x - VEH_L / 2 + 0.6, v.y - 0.7, 1.4]]))
            cv2.fillPoly(img, [np.round(rear * 8).astype(np.int32)], (35, 40, 50), lineType=cv2.LINE_AA, shift=3)
            hulls[v.vid] = (p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max(), cv2.contourArea(hull.astype(np.float32) / 8))
        return img, ids, hulls


def degrade(img: np.ndarray, sc: Scenario, t: float, rng: np.random.Generator) -> np.ndarray:
    """Условия съёмки: шум сенсора, колебания яркости, пониженное разрешение."""
    f = img.astype(np.float32)
    if sc.flicker:
        f += sc.flicker * math.sin(2 * math.pi * t / 7.0)
    if sc.noise_sigma:
        f += rng.normal(0, sc.noise_sigma, f.shape).astype(np.float32)
    out = np.clip(f, 0, 255).astype(np.uint8)
    if sc.scale != 1.0:
        out = cv2.resize(out, None, fx=sc.scale, fy=sc.scale, interpolation=cv2.INTER_AREA)
    return out


def frames(sc: Scenario):
    """Кадры сцены и «правда» о них: (t, кадр или None при отказе камеры, GTFrame)."""
    rnd = Renderer(sc)
    rng = np.random.default_rng(sc.seed + 7)
    W, Hh = sc.camera.width, sc.camera.height_px
    for t, vehicles, red in simulate(sc):
        img, ids, hulls = rnd.render(t, vehicles)
        bc = np.bincount((ids + 1).ravel())
        counts = {i - 1: int(c) for i, c in enumerate(bc) if i > 0 and c}
        gts = []
        for v in vehicles:
            if v.vid not in hulls:
                continue
            x0, y0, x1, y1, area = hulls[v.vid]
            cx0, cy0, cx1, cy1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, Hh - 1)
            if cx1 <= cx0 or cy1 <= cy0:
                continue
            vis = counts.get(v.vid, 0) / max(area, 1.0)
            s = sc.scale
            gts.append(GTVehicle(v.vid, (cx0 * s, cy0 * s, cx1 * s, cy1 * s), min(1.0, vis), v.x, v.y, v.v))
        frame = None
        if not (sc.dropout and sc.dropout[0] <= t < sc.dropout[1]):
            frame = degrade(img, sc, t, rng)
        yield t, frame, GTFrame(t, gts, red)


def ground_truth_crossings(sc: Scenario) -> list[dict]:
    """Все пересечения разметки между полосами 0 и 1 и 1 и 2: время, x, через какую линию, сплошная ли."""
    out = []
    seen = {}
    for _, vehicles, _ in simulate(sc):
        for v in vehicles:
            for (t, x, line) in v.crossed[seen.get(v.vid, 0):]:
                out.append({"vid": v.vid, "t": round(t, 3), "x": round(x, 2), "line_y": line,
                            "solid": line == LANE_W and SOLID[0] <= x <= SOLID[1]})
            seen[v.vid] = len(v.crossed)
    return out


def write_demo(out_dir, seconds: float = 20.0, seed: int = 1) -> dict:
    """Записать тестовое видео синтетической сцены и файлы калибровки и настройки камеры для smartflow_cv.run."""
    import json
    from pathlib import Path
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    sc = Scenario(seed=seed, duration=seconds)
    w = cv2.VideoWriter(str(out / "synthetic.avi"), cv2.VideoWriter_fourcc(*"MJPG"), sc.fps, (sc.camera.width, sc.camera.height_px))
    for _, f, _ in frames(sc):
        w.write(f)
    w.release()
    (out / "calibration.json").write_text(json.dumps(sc.camera.calibration().to_json(), indent=1), encoding="utf-8")
    camera = {"speed_limit_kmh": 60, "speed_tolerance_kmh": 5, "min_confidence": 0.6,
              "solid_line": {"p": [SOLID[0], LANE_W], "q": [SOLID[1], LANE_W], "name": "сплошная 1|2"},
              "zone": {"x0": 10, "x1": STOP_X, "lanes": [[LANE_W * k, LANE_W * (k + 1)] for k in range(N_LANES)], "stop_x": STOP_X, "count_x": 25}}
    (out / "camera.json").write_text(json.dumps(camera, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"video": str(out / "synthetic.avi"), "calibration": str(out / "calibration.json"), "config": str(out / "camera.json")}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Записать тестовое видео синтетической сцены (не реальная камера)")
    ap.add_argument("--out", default="demo")
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    print(write_demo(a.out, a.seconds, a.seed))
