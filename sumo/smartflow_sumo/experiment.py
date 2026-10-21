"""Эксперимент: фиксированный цикл против адаптивного управления на одинаковых маршрутах.

    cd sumo && python -m smartflow_sumo.experiment --out ../public/data/sumo

Для каждой нагрузки и каждого seed файл маршрутов генерируется один раз (одинаковый для обоих
контроллеров), SUMO запускается с тем же --seed. Повтор с теми же параметрами даёт те же числа.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import statistics
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

from .build import BUILD_DIR, Demand, Scenario, build_net, load_scenario, make_plan, sumo_bin, target, webster_greens
from .control import Timing
from .run import RunResult, run
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
SEEDS = (1, 2, 3)
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


def fixed_plan(sc: Scenario, timing: Timing) -> dict:
    net = BUILD_DIR / sc.id / "net.net.xml"
    if not net.exists():
        build_net(sc)
    _, plan = make_plan(net, sc)
    cycle, greens = webster_greens(plan, lane_flows(sc, demand_for(DESIGN_LOAD)), lost_per_phase=timing.yellow + timing.all_red,
                                   min_green=timing.min_green)
    return {"design_load": DESIGN_LOAD, "cycle_s": round(sum(greens) + plan.n * (timing.yellow + timing.all_red), 1),
            "webster_cycle_s": round(cycle, 1), "greens_s": greens, "phases": [p.name for p in plan.phases]}


def summarize(runs: list[RunResult]) -> list[dict]:
    rows = []
    for load in LOADS:
        for ctrl in ("fixed", "adaptive"):
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
            })
    return rows


def sumo_version() -> str:
    """Версия из `sumo --version` (TraCI-соединения к концу эксперимента уже закрыты)."""
    out = subprocess.run([str(sumo_bin("sumo")), "--version"], capture_output=True, text=True).stdout
    return out.splitlines()[0].replace("Eclipse SUMO sumo", "SUMO").strip() if out else "SUMO ?"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    ap.add_argument("--loads", nargs="*", default=list(LOADS))
    ap.add_argument("--duration", type=float, default=DURATION)
    ap.add_argument("--libsumo", action="store_true", help="libsumo вместо TraCI-сокета (быстрее, тот же API)")
    ap.add_argument("--no-trace", action="store_true")
    a = ap.parse_args(argv)
    sc = load_scenario(SCENARIO)
    build_net(sc)
    timing = Timing()
    fixed = fixed_plan(sc, timing)
    runs: list[RunResult] = []
    t0 = time.time()
    work = a.out / "_work"
    for load in a.loads:
        for seed in a.seeds:
            for ctrl in ("fixed", "adaptive"):
                tr = None
                if not a.no_trace and load == TRACE["load"] and seed == TRACE["seed"]:
                    tr = TraceRecorder(TRACE["window"])
                r = run(sc, ctrl, load, demand_for(load, a.duration), seed, timing=timing, fixed_greens=fixed["greens_s"],
                        libsumo=a.libsumo, trace=tr, work_dir=work)
                runs.append(r)
                if tr:
                    tr.write(a.out / f"trace-{ctrl}.json")
                print(f"{load:6} seed {seed} {ctrl:8} wait {r.mean_wait} s  queue {r.mean_queue}  done {r.completed}/{r.demand_vehicles}"
                      f"  collisions {r.collisions} conflicts {r.conflict_steps} teleports {r.teleports}", flush=True)
    result = {
        "format": "smartflow-sumo-results/1",
        "scenario": {"id": sc.id, "title": sc.title, "assumptions": sc.raw["assumptions"], "osm_facts": sc.raw.get("osm_facts", [])},
        "sumo_version": sumo_version(),
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "params": {
            "loads_veh_h": {k: LOADS[k] for k in a.loads}, "turn_shares": TURNS, "seeds": a.seeds,
            "duration_s": a.duration, "warmup_s": 300, "step_s": 1.0,
            "timing": asdict(timing), "fixed": fixed,
            "adaptive": asdict(__import__("smartflow_sumo.control", fromlist=["AdaptiveParams"]).AdaptiveParams()),
        },
        "summary": summarize(runs),
        "runs": [asdict(r) | {"states": None} for r in runs],
        "elapsed_s": round(time.time() - t0, 1),
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"готово за {result['elapsed_s']} с → {a.out / 'results.json'}")


if __name__ == "__main__":
    main()
