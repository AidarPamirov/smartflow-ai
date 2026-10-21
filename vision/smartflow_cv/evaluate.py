"""Проверка модулей CV на синтетической сцене с известной «правдой».

    cd vision && python -m smartflow_cv.evaluate --out ../public/data/cv

Для каждого условия съёмки и seed прогоняется конвейер и сравнивается с «правдой» сцены:
детекция (точность и полнота при IoU ≥ 0,5), сопровождение (смены номера), скорость (ошибка, км/ч),
превышение скорости, пересечение сплошной, подсчёт потока, длина очереди. Результат — JSON
(smartflow-cv-eval/1) и несколько кадров с разметкой. Это проверка на синтетике, а не на реальном видео.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from . import synthetic as syn
from .lane_crossing_detection import GroundLine
from .pipeline import Pipeline, PipelineConfig
from .traffic_density_estimation import Zone
from .vehicle_detection import BackgroundDetector
from .vehicle_tracking import iou

FORMAT = "smartflow-cv-eval/1"
LIMIT, TOL = 60.0, 5.0
EVAL_X = (10.0, 56.0)  # где машина достаточно крупная, чтобы требовать её обнаружения, м
COUNT_X = 25.0

LIGHT = 350.0  # авт/ч на полосу — свободный поток, машины в кадре почти не перекрываются
CONDITIONS = {
    "light": {"title": "Свободный поток", "params": {"flow_veh_h_per_lane": LIGHT}},
    "clear": {"title": "Плотный поток с очередями", "params": {}},
    "noisy": {"title": "Плотный + шум и мерцание", "params": {"noise_sigma": 12.0, "flicker": 18.0}},
    "lowres": {"title": "Плотный, 480×270", "params": {"scale": 0.5}},
    "dropout": {"title": "Свободный, камера пропала на 3 с", "params": {"flow_veh_h_per_lane": LIGHT, "dropout": (40.0, 43.0)}},
    "uncalibrated": {"title": "Свободный, без калибровки", "params": {"flow_veh_h_per_lane": LIGHT}, "no_calibration": True},
}


def make_config() -> PipelineConfig:
    lanes = tuple((syn.LANE_W * k, syn.LANE_W * (k + 1)) for k in range(syn.N_LANES))
    return PipelineConfig(speed_limit_kmh=LIMIT, speed_tolerance_kmh=TOL,
                          solid_line=GroundLine((syn.SOLID[0], syn.LANE_W), (syn.SOLID[1], syn.LANE_W), "сплошная 1|2"),
                          zone=Zone(EVAL_X[0], syn.STOP_X, lanes, stop_x=syn.STOP_X, count_x=COUNT_X))


def road_mask(sc: syn.Scenario) -> np.ndarray:
    cam = sc.camera
    m = np.zeros((round(cam.height_px * sc.scale), round(cam.width * sc.scale)), np.uint8)
    p = cam.project(np.array([[x, y, 0.0] for x, y in [(0, -0.8), (300, -0.8), (300, syn.N_LANES * syn.LANE_W + 0.8), (0, syn.N_LANES * syn.LANE_W + 0.8)]]))
    cv2.fillPoly(m, [np.round(p * sc.scale).astype(np.int32)], 255)
    return m


def run_one(cond: str, seed: int, duration: float, shots: dict | None = None) -> dict:
    spec = CONDITIONS[cond]
    sc = replace(syn.Scenario(seed=seed, duration=duration), **spec["params"])
    cal = None if spec.get("no_calibration") else sc.camera.calibration(sc.scale)
    pipe = Pipeline(make_config(), cal, detector=BackgroundDetector(roi=road_mask(sc)))
    det_tp = det_fp = det_fn = 0
    rec = {"isolated": [0, 0], "overlapping": [0, 0]}  # [найдено, всего]: машина отдельно или перекрыта другой в кадре
    gt_to_tracks: dict[int, list[int]] = defaultdict(list)
    track_votes: dict[int, Counter] = defaultdict(Counter)
    speed_err, speed_ok, speed_total = [], 0, 0
    gt_max_speed: dict[int, float] = defaultdict(float)
    count_err, queue_err = [], []
    gt_count_seen: dict[int, float] = {}
    t_proc = 0.0
    frames_n = 0
    for t, frame, gt in syn.frames(sc):
        t0 = time.perf_counter()
        res = pipe.process(t, frame)
        t_proc += time.perf_counter() - t0
        frames_n += 1
        for g in gt.vehicles:
            if EVAL_X[0] <= g.x <= EVAL_X[1] and g.visible >= 0.6:
                gt_max_speed[g.vid] = max(gt_max_speed[g.vid], g.v * 3.6)
        for g in gt.vehicles:
            if g.x >= COUNT_X and g.vid not in gt_count_seen:
                gt_count_seen[g.vid] = t
        if frame is None or t < 1.0:
            continue
        must = [g for g in gt.vehicles if EVAL_X[0] <= g.x <= EVAL_X[1] and g.visible >= 0.6]
        other = [g for g in gt.vehicles if g not in must]
        dets = [d.box for d in res.detections]
        if dets and must:
            cost = np.array([[1 - iou(d, g.box) for g in must] for d in dets])
            r, c = linear_sum_assignment(cost)
            pairs = [(i, j) for i, j in zip(r, c) if cost[i, j] <= 0.5]
        else:
            pairs = []
        used_d = {i for i, _ in pairs}
        hit_gt = {j for _, j in pairs}
        for j, g in enumerate(must):
            k = "overlapping" if any(iou(g.box, o.box) > 0.02 for o in gt.vehicles if o is not g) else "isolated"
            rec[k][1] += 1
            rec[k][0] += j in hit_gt
        det_tp += len(pairs)
        det_fn += len(must) - len(pairs)
        for i, d in enumerate(dets):
            if i not in used_d and not any(iou(d, g.box) >= 0.5 for g in other):
                det_fp += 1
        # треки ↔ «правда»
        trs = res.tracks
        if trs and must:
            cost = np.array([[1 - iou(tr["box"], g.box) for g in must] for tr in trs])
            r, c = linear_sum_assignment(cost)
            for i, j in zip(r, c):
                if cost[i, j] > 0.5:
                    continue
                g, tr = must[j], trs[i]
                gt_to_tracks[g.vid].append(tr["track"])
                track_votes[tr["track"]][g.vid] += 1
                if g.v >= 1.0:
                    speed_total += 1
                    if tr["speed_kmh"] is not None:
                        speed_ok += 1
                        speed_err.append(abs(tr["speed_kmh"] - g.v * 3.6))
        if res.density and res.density.status == "ok":
            for k in range(syn.N_LANES):
                gq = _gt_queue(gt, k)
                queue_err.append(abs(res.density.queue_m[k] - gq))
            gt_n = sum(1 for g in gt.vehicles if EVAL_X[0] <= g.x <= syn.STOP_X and 0 <= g.y < syn.N_LANES * syn.LANE_W)
            count_err.append(abs(sum(res.density.per_lane) - gt_n))
        if shots is not None and cond in shots and any(abs(t - s) < 1e-6 for s in shots[cond]["at"]):
            shots[cond]["frames"].append(_overlay(frame, res, pipe, sc, t))
    # смены номеров: сколько раз у одной машины менялся трек
    id_switches = sum(sum(1 for a, b in zip(ts, ts[1:]) if a != b) for ts in gt_to_tracks.values())
    tracked = [v for v, ts in gt_to_tracks.items() if len(ts) >= 25]
    owner = {tid: votes.most_common(1)[0][0] for tid, votes in track_votes.items()}
    # события
    summ = pipe.summary()
    ev = summ["events"]
    gt_cross = [c for c in syn.ground_truth_crossings(sc) if c["solid"] and (not sc.dropout or not (sc.dropout[0] - 1 <= c["t"] <= sc.dropout[1] + 1))]
    viol = [e for e in ev if e["type"] == "solid_line_crossing"]
    insuff = [e for e in ev if e["type"] == "solid_line_insufficient_data"]
    hit = set()
    tp_c = 0
    for e in viol:
        vid = owner.get(e["track"])
        m = next((i for i, c in enumerate(gt_cross) if i not in hit and c["vid"] == vid and abs(c["t"] - e["t"]) <= 2.5), None)
        if m is not None:
            hit.add(m)
            tp_c += 1
    speeders = {v for v, s in gt_max_speed.items() if s > LIMIT + TOL + 3}
    clean = {v for v, s in gt_max_speed.items() if s <= LIMIT + TOL - 3}
    sp_ev = [e for e in ev if e["type"] == "speed_over_limit"]
    sp_tp = sum(1 for e in sp_ev if owner.get(e["track"]) in speeders)
    sp_fp = sum(1 for e in sp_ev if owner.get(e["track"]) in clean)
    flagged = {owner.get(e["track"]) for e in sp_ev}
    gt_count = sum(1 for v, t in gt_count_seen.items() if 1.0 <= t <= duration)
    pct = lambda a, b: round(100 * a / b, 1) if b else None  # noqa: E731
    return {
        "condition": cond, "seed": seed, "frames": frames_n, "missing_frames": summ["missing_frames"],
        "ms_per_frame": round(1000 * t_proc / max(frames_n, 1), 1),
        "detection": {"precision_pct": pct(det_tp, det_tp + det_fp), "recall_pct": pct(det_tp, det_tp + det_fn), "tp": det_tp, "fp": det_fp, "fn": det_fn,
                      "recall_isolated_pct": pct(*rec["isolated"]), "recall_overlapping_pct": pct(*rec["overlapping"]),
                      "overlapping_share_pct": pct(rec["overlapping"][1], rec["overlapping"][1] + rec["isolated"][1])},
        "tracking": {"id_switches": id_switches, "vehicles": len(tracked), "id_switches_per_vehicle": round(id_switches / len(tracked), 3) if tracked else None},
        "speed": {"status_counts": summ["speed_estimates"], "coverage_pct": pct(speed_ok, speed_total),
                  "mae_kmh": round(statistics.fmean(speed_err), 2) if speed_err else None,
                  "p95_abs_err_kmh": round(float(np.percentile(speed_err, 95)), 2) if speed_err else None,
                  "within_5kmh_pct": pct(sum(1 for e in speed_err if e <= 5), len(speed_err)) if speed_err else None},
        "speeding": {"gt_speeders": len(speeders), "events": len(sp_ev), "true_events": sp_tp, "false_events": sp_fp,
                     "recall_pct": pct(len(speeders & flagged), len(speeders)) if cal else None},
        "solid_line": {"gt_crossings": len(gt_cross), "events": len(viol), "true_events": tp_c, "insufficient_data": len(insuff),
                       "precision_pct": pct(tp_c, len(viol)) if cal else None, "recall_pct": pct(tp_c, len(gt_cross)) if cal else None},
        "counting": {"gt": gt_count, "estimated": None if summ["flow_veh_h"] is None else pipe.density.counted},
        "density": {"count_mae": round(statistics.fmean(count_err), 2) if count_err else None},
        "queue": {"mae_m": round(statistics.fmean(queue_err), 2) if queue_err else None},
        "module_status": res.status,
    }


def blank_without_calibration(run: dict) -> dict:
    """Без калибровки скорость и линия не работают: их счётчики событий — «нет данных», а не ноль найденных."""
    if run["module_status"].get("speed_estimation") == "no_calibration":
        run["speeding"].update(events=None, true_events=None, false_events=None, recall_pct=None)
        run["speed"]["coverage_pct"] = None
    if run["module_status"].get("lane_crossing_detection") == "no_calibration":
        run["solid_line"].update(events=None, true_events=None, insufficient_data=None, precision_pct=None, recall_pct=None)
    return run


def _gt_queue(gt: syn.GTFrame, lane: int) -> float:
    xs = sorted((g.x for g in gt.vehicles if int(g.y // syn.LANE_W) == lane and g.v * 3.6 <= 5.0 and g.x < syn.STOP_X), reverse=True)
    q, edge = 0.0, syn.STOP_X
    for x in xs:
        rear = x - syn.VEH_L / 2
        if edge - (x + syn.VEH_L / 2) <= 12.0:
            q, edge = syn.STOP_X - rear, rear
        else:
            break
    return q


def _overlay(frame, res, pipe: Pipeline, sc: syn.Scenario, t: float) -> np.ndarray:
    img = frame.copy()
    s = sc.scale
    if pipe.cal is not None:
        p = pipe.cal.to_image([[syn.SOLID[0], syn.LANE_W], [syn.SOLID[1], syn.LANE_W]])
        cv2.line(img, tuple(np.round(p[0]).astype(int)), tuple(np.round(p[1]).astype(int)), (0, 200, 255), max(1, round(3 * s)))
    for d in res.detections:
        x0, y0, x1, y1 = map(int, d.box)
        cv2.rectangle(img, (x0, y0), (x1, y1), (120, 120, 120), 1)
    for tr in res.tracks:
        x0, y0, x1, y1 = map(int, tr["box"])
        cv2.rectangle(img, (x0, y0), (x1, y1), (60, 220, 60), max(1, round(2 * s)))
        label = f"#{tr['track']}" + (f" {tr['speed_kmh']:.0f} km/h" if tr["speed_kmh"] is not None else "")
        cv2.putText(img, label, (x0, max(10, y0 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * max(s, 0.6), (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(img, f"t={t:.1f}s  synthetic scene", (8, img.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * max(s, 0.6), (255, 255, 255), 1, cv2.LINE_AA)
    return img


def aggregate(runs: list[dict]) -> list[dict]:
    out = []
    for cond in CONDITIONS:
        rs = [r for r in runs if r["condition"] == cond]
        if not rs:
            continue

        def m(path):
            xs = [_get(r, path) for r in rs]
            xs = [x for x in xs if x is not None]
            return [round(statistics.fmean(xs), 2), round(statistics.stdev(xs), 2) if len(xs) > 1 else 0.0] if xs else [None, None]

        def s(path):
            xs = [_get(r, path) for r in rs]
            return None if any(x is None for x in xs) else sum(xs)

        out.append({
            "condition": cond, "title": CONDITIONS[cond]["title"], "seeds": [r["seed"] for r in rs],
            "detection_precision_pct": m("detection.precision_pct"), "detection_recall_pct": m("detection.recall_pct"),
            "detection_recall_isolated_pct": m("detection.recall_isolated_pct"), "detection_recall_overlapping_pct": m("detection.recall_overlapping_pct"),
            "overlapping_share_pct": m("detection.overlapping_share_pct"),
            "id_switches_per_vehicle": m("tracking.id_switches_per_vehicle"),
            "speed_coverage_pct": m("speed.coverage_pct"), "speed_mae_kmh": m("speed.mae_kmh"), "speed_p95_abs_err_kmh": m("speed.p95_abs_err_kmh"),
            "speed_within_5kmh_pct": m("speed.within_5kmh_pct"),
            "speeding_gt": s("speeding.gt_speeders"), "speeding_true": s("speeding.true_events"), "speeding_false": s("speeding.false_events"),
            "solid_gt": s("solid_line.gt_crossings"), "solid_events": s("solid_line.events"), "solid_true": s("solid_line.true_events"),
            "solid_insufficient": s("solid_line.insufficient_data"),
            "count_gt": s("counting.gt"), "count_est": s("counting.estimated"),
            "density_count_mae": m("density.count_mae"), "queue_mae_m": m("queue.mae_m"),
            "ms_per_frame": m("ms_per_frame"), "missing_frames": s("missing_frames"),
            "module_status": rs[0]["module_status"],
        })
    return out


def _get(d, path):
    for k in path.split("."):
        d = d.get(k) if isinstance(d, dict) else None
    return d


def modules_info() -> list[dict]:
    return [
        {"id": "vehicle_detection", "title": "Детекция машин", "impl": "вычитание фона (OpenCV), без нейросети", "verified": "синтетическая сцена; реальное видео UA-DETRAC — почти не работает",
         "alt": "нейросеть YOLOX-tiny через OpenCV DNN (веса скачиваются отдельно) — проверена на UA-DETRAC, на синтетической сцене не проверялась"},
        {"id": "vehicle_tracking", "title": "Сопровождение", "impl": "IoU + венгерский алгоритм, анонимные номера треков", "verified": "синтетическая сцена"},
        {"id": "speed_estimation", "title": "Скорость", "impl": "перемещение в метрах по калибровке за 1 с (МНК)", "verified": "синтетическая сцена"},
        {"id": "lane_crossing_detection", "title": "Пересечение сплошной", "impl": "траектория трека против отрезка линии на дороге, гистерезис 0,6 м", "verified": "синтетическая сцена"},
        {"id": "traffic_density_estimation", "title": "Плотность, очередь, поток", "impl": "по трекам на плоскости дороги", "verified": "синтетическая сцена"},
        {"id": "seatbelt_assessment", "title": "Ремень безопасности", "impl": "интерфейс для специализированной модели + проверка качества кадра", "verified": None,
         "alt": "модель не подключена: всегда «невозможно определить»"},
    ]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Проверка модулей CV на синтетической сцене")
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--seeds", type=int, nargs="*", default=[1, 2])
    ap.add_argument("--duration", type=float, default=90.0)
    ap.add_argument("--conditions", nargs="*", default=list(CONDITIONS))
    a = ap.parse_args(argv)
    t0 = time.time()
    shots = {"light": {"at": [30.0], "frames": []}, "clear": {"at": [26.0, 52.0], "frames": []}, "noisy": {"at": [52.0], "frames": []},
             "lowres": {"at": [52.0], "frames": []}}
    runs = []
    for cond in a.conditions:
        for seed in a.seeds:
            r = blank_without_calibration(run_one(cond, seed, a.duration, shots if seed == a.seeds[0] else None))
            runs.append(r)
            print(f"{cond:13} seed {seed}: det P/R {r['detection']['precision_pct']}/{r['detection']['recall_pct']}  "
                  f"speed MAE {r['speed']['mae_kmh']} km/h  solid {r['solid_line']['true_events']}/{r['solid_line']['gt_crossings']} "
                  f"(events {r['solid_line']['events']})  {r['ms_per_frame']} ms/frame", flush=True)
    a.out.mkdir(parents=True, exist_ok=True)
    images = []
    for cond, sh in shots.items():
        for i, img in enumerate(sh["frames"]):
            name = f"cv-{cond}-{i + 1}.jpg"
            cv2.imwrite(str(a.out / name), img, [cv2.IMWRITE_JPEG_QUALITY, 82])
            images.append({"file": name, "condition": cond, "t": sh["at"][i]})
    sc = syn.Scenario()
    result = {
        "format": FORMAT,
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "opencv": cv2.__version__,
        "scene": {"note": "Синтетическая сцена: прямая дорога из 3 полос, камера на высоте 12 м, машины-параллелепипеды по модели IDM, "
                          "светофор у стоп-линии в 50 м, перестроения, в том числе через сплошную. Не видео с улиц Бишкека.",
                  "fps": sc.fps, "duration_s": a.duration, "frame_px": [sc.camera.width, sc.camera.height_px], "camera_height_m": sc.camera.height,
                  "solid_line_x_m": list(syn.SOLID), "stop_line_x_m": syn.STOP_X, "eval_zone_x_m": list(EVAL_X), "speed_limit_kmh": LIMIT,
                  "speed_tolerance_kmh": TOL},
        "modules": modules_info(),
        "conditions": {k: v["title"] for k, v in CONDITIONS.items() if k in a.conditions},
        "summary": aggregate(runs),
        "runs": runs,
        "images": images,
        "elapsed_s": round(time.time() - t0, 1),
    }
    (a.out / "cv-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"готово за {result['elapsed_s']} с → {a.out / 'cv-results.json'}")


if __name__ == "__main__":
    main()
