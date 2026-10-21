"""Эксперимент: фиксированный цикл против адаптивного управления на одинаковых маршрутах.

    cd sumo && python -m smartflow_sumo.experiment --out ../public/data/sumo

Для каждой нагрузки и каждого seed файл маршрутов генерируется один раз и используется всеми контроллерами
(в results.json записан его SHA-256), SUMO запускается с тем же --seed. Повтор с теми же параметрами даёт те же числа.

Контроллеры:
  fixed        — фиксированный цикл по Уэбстеру, рассчитанный на среднюю нагрузку и одинаковый для всех нагрузок
                 (так работает обычный светофор с одной программой);
  fixed_tuned  — фиксированный цикл, пересчитанный по Уэбстеру под каждую нагрузку («идеально настроенный»
                 фиксированный план: знает спрос заранее; самый сильный фиксированный соперник);
  adaptive     — адаптивный контроллер на правилах (control.py), пределы зелёного от плана fixed.
Сравнение парное по seed: средняя разность, 95 % ДИ, в скольких seed лучше (stats.py).
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import hashlib
import json
import os
import statistics
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from pathlib import Path

from .build import BUILD_DIR, Demand, Scenario, build_net, load_scenario, make_plan, sumo_bin, target, webster_greens, write_routes
from .control import Timing
from .run import RunResult, adaptive_limits, run
from .stats import describe, paired
from .trace import TraceRecorder

SCENARIO = "chui-manas"
#: Синтетические интенсивности, авт/ч на подход (допущения, не измерения).
# Интенсивности, авт/ч на подход (через светофор). Синтетика: уровни подобраны по расчётной загрузке
# перекрёстка Y (Уэбстер) ≈ 0,47 / 0,64 / 0,80 для схемы с раздельными фазами, а не по реальным подсчётам.
LOADS: dict[str, dict[str, float]] = {
    "low": {"E": 450, "W": 450, "N": 300, "S": 150},
    "medium": {"E": 600, "W": 600, "N": 400, "S": 220},
    "high": {"E": 750, "W": 750, "N": 500, "S": 270},
}
TURNS = {"L": 0.15, "T": 0.70, "R": 0.15}
SEEDS = tuple(range(1, 31))
CONTROLLERS = ("fixed", "fixed_tuned", "adaptive")
DURATION = 3600.0
DESIGN_LOAD = "medium"  # на эту нагрузку рассчитан фиксированный цикл (как настраивают реальные светофоры)
TRACE = {"load": "medium", "seed": 1, "window": (1200.0, 1800.0)}


def demand_for(load: str, duration: float = DURATION) -> Demand:
    return Demand(flows=dict(LOADS[load]), turns=dict(TURNS), duration=duration)


def lane_flows(sc: Scenario, demand: Demand) -> dict[str, float]:
    """Оценка потока по полосам: поток манёвра делится поровну между полосами, где он разрешён."""
    out: dict[str, float] = {}
    for a, arm in sc.arms.items():
        q = demand.flows.get(a, 0.0)
        allowed = sorted({t for use in arm.lanes_in for t in use})
        tot = sum(demand.turns[t] for t in allowed)
        n = len(arm.lanes_in)
        for t in allowed:
            lanes = [n - 1 - pos for pos, use in enumerate(arm.lanes_in) if t in use]
            for l in lanes:
                key = f"{a}_in_{l}"
                out[key] = out.get(key, 0.0) + q * demand.turns[t] / tot / len(lanes)
    return out


def fixed_plan(sc: Scenario, timing: Timing, load: str = DESIGN_LOAD) -> dict:
    """Фиксированный план по Уэбстеру на нагрузку load (по умолчанию — расчётная средняя)."""
    net = BUILD_DIR / sc.id / "net.net.xml"
    if not net.exists():
        build_net(sc)
    _, plan = make_plan(net, sc)
    cycle, greens = webster_greens(plan, lane_flows(sc, demand_for(load)), lost_per_phase=timing.yellow + timing.all_red,
                                   min_green=timing.min_green)
    return {"design_load": load, "cycle_s": round(sum(greens) + plan.n * (timing.yellow + timing.all_red), 1),
            "webster_cycle_s": round(cycle, 1), "greens_s": greens, "phases": [p.name for p in plan.phases]}


def summarize(runs: list[RunResult]) -> list[dict]:
    rows = []
    for load in LOADS:
        for ctrl in CONTROLLERS:
            rs = [r for r in runs if r.load == load and r.controller == ctrl]
            if not rs:
                continue
            def m(f):
                xs = [f(r) for r in rs if f(r) is not None]
                return (round(statistics.fmean(xs), 2), round(statistics.stdev(xs), 2) if len(xs) > 1 else 0.0) if xs else (None, None)
            rows.append({
                "load": load, "controller": ctrl, "runs": len(rs), "seeds": [r.seed for r in rs],
                "mean_wait": m(lambda r: r.mean_wait), "mean_time_loss": m(lambda r: r.mean_time_loss),
                "mean_queue": m(lambda r: r.mean_queue), "max_queue_approach": m(lambda r: r.max_queue_approach),
                "completed": m(lambda r: r.completed), "unfinished": m(lambda r: r.unfinished),
                "demand_vehicles": m(lambda r: r.demand_vehicles),
                "collisions": sum(r.collisions for r in rs), "teleports": sum(r.teleports for r in rs),
                "conflict_steps": sum(r.conflict_steps for r in rs),
                "min_green_seen": min(r.min_green_seen for r in rs if r.min_green_seen is not None),
                "min_yellow_seen": min(r.min_yellow_seen for r in rs if r.min_yellow_seen is not None),
                "min_allred_seen": min(r.min_allred_seen for r in rs if r.min_allred_seen is not None),
                "p95_travel_time": m(lambda r: r.p95_travel_time),
                "total_wait_veh_h": m(lambda r: r.total_wait_veh_h),
                "mean_stops": m(lambda r: r.mean_stops),
                "throughput_veh_h": m(lambda r: r.throughput_veh_h),
                # худший подход: наибольшее среднее ожидание среди подходов (чтобы выигрыш в среднем не прятал проигрыш направления)
                "worst_approach_wait": m(lambda r: max(r.wait_by_approach.values()) if r.wait_by_approach else None),
                "wait_by_approach": {a: m(lambda r, a=a: r.wait_by_approach.get(a)) for a in "NESW"},
                "max_wait_vehicle": m(lambda r: max(r.max_wait_by_approach.values()) if r.max_wait_by_approach else None),
                "safety_overrides": sum(r.safety_overrides for r in rs),
                "fallbacks": sum(1 for r in rs if r.fallback_at is not None),
                "clearance_hold_s": m(lambda r: r.clearance_hold_s),
                "decision_reasons": _merge(r.decision_reasons for r in rs),
                # среднее, ст. отклонение, 95 % ДИ среднего, мин / медиана / макс по seed
                "stats": {k: describe(get(r) for r in rs) for k, get, _ in COMPARE_METRICS},
            })
    return rows


def _merge(dicts) -> dict:
    out: dict[str, int] = {}
    for d in dicts:
        for k, v in d.items():
            out[k] = out.get(k, 0) + v
    return out


def sumo_version() -> str:
    """Версия из `sumo --version` (TraCI-соединения к концу эксперимента уже закрыты)."""
    out = subprocess.run([str(sumo_bin("sumo")), "--version"], capture_output=True, text=True).stdout
    return out.splitlines()[0].replace("Eclipse SUMO sumo", "SUMO").strip() if out else "SUMO ?"


#: метрики парного сравнения: (ключ, как получить из прогона, меньше — лучше)
COMPARE_METRICS: tuple[tuple[str, object, bool], ...] = (
    ("mean_wait", lambda r: r.mean_wait, True),
    ("mean_time_loss", lambda r: r.mean_time_loss, True),
    ("p95_travel_time", lambda r: r.p95_travel_time, True),
    ("mean_queue", lambda r: r.mean_queue, True),
    ("worst_approach_wait", lambda r: max(r.wait_by_approach.values()) if r.wait_by_approach else None, True),
    ("mean_stops", lambda r: r.mean_stops, True),
    ("throughput_veh_h", lambda r: r.throughput_veh_h, False),
    ("completed", lambda r: r.completed, False),
    ("unfinished", lambda r: r.unfinished, True),
)
#: какие пары сравниваются: (A, B) — «A против B»
PAIRS = (("adaptive", "fixed"), ("adaptive", "fixed_tuned"), ("fixed_tuned", "fixed"))


def compare(runs: list[RunResult]) -> list[dict]:
    """Парные сравнения по seed для каждой нагрузки, пары контроллеров и метрики."""
    out = []
    for load in dict.fromkeys(r.load for r in runs):
        for a, b in PAIRS:
            ra = {r.seed: r for r in runs if r.load == load and r.controller == a}
            rb = {r.seed: r for r in runs if r.load == load and r.controller == b}
            if not ra or not rb:
                continue
            for key, get, lower in COMPARE_METRICS:
                res = paired({s: get(r) for s, r in ra.items()}, {s: get(r) for s, r in rb.items()}, lower_is_better=lower)
                if res:
                    out.append({"load": load, "a": a, "b": b, "metric": key, "lower_is_better": lower, **res})
    return out


def routes_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _job(args: tuple) -> RunResult:
    """Один прогон в отдельном процессе (своё соединение TraCI)."""
    sc_id, ctrl, load, seed, duration, greens, routes, work, trace_out, libsumo = args
    sc = load_scenario(sc_id)
    tr = TraceRecorder(TRACE["window"]) if trace_out else None
    r = run(sc, ctrl, load, demand_for(load, duration), seed, timing=Timing(), fixed_greens=greens, libsumo=libsumo, trace=tr,
            work_dir=Path(work), routes_file=Path(routes))
    if tr:
        tr.write(Path(trace_out))
    return r


CSV_FIELDS = ("load", "controller", "seed", "demand_vehicles", "completed", "unfinished", "measured_trips", "mean_wait", "mean_time_loss",
              "p95_travel_time", "mean_queue", "max_queue_approach", "mean_stops", "throughput_veh_h", "total_wait_veh_h", "switches",
              "collisions", "teleports", "conflict_steps", "safety_overrides", "clearance_hold_s", "fallback_at", "sim_end")


def write_csv(runs: list[RunResult], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_FIELDS)
        for r in runs:
            d = asdict(r)
            w.writerow([d[k] for k in CSV_FIELDS])


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    ap.add_argument("--loads", nargs="*", default=list(LOADS))
    ap.add_argument("--controllers", nargs="*", default=list(CONTROLLERS))
    ap.add_argument("--duration", type=float, default=DURATION)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="параллельных прогонов SUMO")
    ap.add_argument("--libsumo", action="store_true", help="libsumo вместо TraCI-сокета (быстрее, тот же API)")
    ap.add_argument("--no-trace", action="store_true")
    a = ap.parse_args(argv)
    sc = load_scenario(SCENARIO)
    build_net(sc)
    timing = Timing()
    fixed = fixed_plan(sc, timing)
    tuned = {load: fixed_plan(sc, timing, load) for load in a.loads}
    work = (a.out / "_work").resolve()
    work.mkdir(parents=True, exist_ok=True)
    # маршруты: один файл на (нагрузка, seed), общий для всех контроллеров
    routes, hashes = {}, {}
    for load in a.loads:
        for seed in a.seeds:
            p = work / f"routes_{load}_{seed}.rou.xml"
            write_routes(sc, demand_for(load, a.duration), seed, p)
            routes[(load, seed)], hashes[f"{load}/{seed}"] = p, routes_sha256(p)
    jobs = []
    for load in a.loads:
        for seed in a.seeds:
            for ctrl in a.controllers:
                greens = tuned[load]["greens_s"] if ctrl == "fixed_tuned" else fixed["greens_s"]
                trace = (not a.no_trace and ctrl in ("fixed", "adaptive") and load == TRACE["load"] and seed == TRACE["seed"])
                jobs.append((sc.id, ctrl, load, seed, a.duration, greens, str(routes[(load, seed)]), str(work),
                             str((a.out / f"trace-{ctrl}.json").resolve()) if trace else None, a.libsumo))
    t0 = time.time()
    runs: list[RunResult] = []
    with ProcessPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        for r in ex.map(_job, jobs):
            runs.append(r)
            print(f"{r.load:6} seed {r.seed:2} {r.controller:11} wait {r.mean_wait} s  p95 {r.p95_travel_time} s  queue {r.mean_queue}  "
                  f"done {r.completed}/{r.demand_vehicles}  collisions {r.collisions} conflicts {r.conflict_steps} teleports {r.teleports}",
                  flush=True)
    result = {
        "format": "smartflow-sumo-results/2",
        "scenario": {"id": sc.id, "title": sc.title, "assumptions": sc.raw["assumptions"], "osm_facts": sc.raw.get("osm_facts", [])},
        "sumo_version": sumo_version(),
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "params": {
            "loads_veh_h": {k: LOADS[k] for k in a.loads}, "turn_shares": TURNS, "seeds": a.seeds, "controllers": a.controllers,
            "duration_s": a.duration, "warmup_s": 300, "step_s": 1.0,
            "timing": asdict(timing), "fixed": fixed, "fixed_tuned": tuned,
            # параметры, с которыми адаптивный контроллер действительно работал (пределы — от плана fixed)
            "adaptive": asdict(adaptive_limits(fixed["greens_s"])),
            "routes_sha256": hashes,
        },
        "summary": summarize(runs),
        "comparisons": compare(runs),
        "runs": [asdict(r) | {"states": None, "decisions": None} for r in runs],
        "elapsed_s": round(time.time() - t0, 1),
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    write_csv(runs, a.out / "results-runs.csv")
    print(f"готово за {result['elapsed_s']} с → {a.out / 'results.json'}, {a.out / 'results-runs.csv'}")


if __name__ == "__main__":
    main()
