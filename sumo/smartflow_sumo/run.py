"""Один прогон SUMO под управлением контроллера через TraCI.

Связь с SUMO — только здесь: наблюдения из TraCI → контроллер (control.py) → страж → сигнал в SUMO.
Независимые проверки каждый шаг: фактическое состояние светофора в SUMO сверяется с матрицей
конфликтов сети, считаются столкновения и телепортации.
"""
from __future__ import annotations

import os
import statistics
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .build import BUILD_DIR, TLS_ID, Demand, Scenario, build_net, make_plan, sumo_bin, write_routes
from .control import AdaptiveController, AdaptiveParams, Controller, FixedTimeController, Observation, SignalPlan, SignalSupervisor, Timing, tick
from .trace import TraceRecorder

#: зона детектора перед стоп-линией, м (≈ 2 с хода при 50 км/ч): пустая зона = разрыв потока
DETECTOR_M = 30.0
WARMUP = 300.0


@dataclass
class RunResult:
    scenario: str
    controller: str
    load: str
    seed: int
    plan: str
    demand_vehicles: int
    completed: int
    unfinished: int
    mean_wait: float | None  # среднее время ожидания на поездку (скорость < 0,1 м/с), с
    mean_time_loss: float | None  # средняя задержка относительно свободного проезда, с
    mean_queue: float  # среднее число стоящих машин на всех подходах (за время спроса)
    max_queue_approach: int  # максимум стоящих машин на одном подходе
    queue_by_approach: dict[str, float]
    collisions: int
    teleports: int
    conflict_steps: int  # шаги, на которых в SUMO горели зелёные конфликтующим связям (должно быть 0)
    switches: int
    min_green_seen: float | None
    min_yellow_seen: float | None
    min_allred_seen: float | None
    sim_end: float
    measured_trips: int  # поездки, начавшиеся после разогрева
    fixed_cycle: dict | None = None
    states: list = field(default_factory=list, repr=False)


def adaptive_limits(fixed_greens: list[float] | None) -> AdaptiveParams:
    """Пределы зелёного адаптивного контроллера: 1,5 × зелёного расчётного плана, но не меньше 15 с.

    Так обычно задают максимум для актуированного регулирования: от расчётного плана, а не подбором.
    """
    if not fixed_greens:
        return AdaptiveParams()
    return AdaptiveParams(max_green_by_phase=tuple(max(15.0, round(1.5 * g)) for g in fixed_greens))


def make_controller(kind: str, plan: SignalPlan, fixed_greens: list[float] | None) -> Controller:
    if kind == "fixed":
        if not fixed_greens:
            raise ValueError("для фиксированного цикла нужны длительности зелёного")
        return FixedTimeController(fixed_greens)
    if kind == "adaptive":
        return AdaptiveController(adaptive_limits(fixed_greens))
    raise ValueError(f"неизвестный контроллер {kind}")


def _traci(libsumo: bool):
    if libsumo:
        import libsumo as tc  # noqa: N813
        return tc
    import traci as tc
    return tc


def run(sc: Scenario, controller_kind: str, load: str, demand: Demand, seed: int, *, timing: Timing = Timing(),
        fixed_greens: list[float] | None = None, drain: float = 1800.0, step: float = 1.0, libsumo: bool = False,
        trace: TraceRecorder | None = None, keep_states: bool = False, work_dir: Path | None = None) -> RunResult:
    net = BUILD_DIR / sc.id / "net.net.xml"
    if not net.exists():
        build_net(sc)
    plan_name, plan = make_plan(net, sc)
    work = Path(work_dir or tempfile.mkdtemp(prefix="sf-sumo-"))
    routes = work / f"routes_{load}_{seed}.rou.xml"
    n_demand = write_routes(sc, demand, seed, routes)
    tripinfo = work / f"tripinfo_{controller_kind}_{load}_{seed}.xml"
    ctrl = make_controller(controller_kind, plan, fixed_greens)
    sup = SignalSupervisor(plan, timing)
    tc = _traci(libsumo)
    cmd = [sumo_bin("sumo"), "-n", str(net), "-r", str(routes), "--step-length", str(step), "--seed", str(seed),
           "--no-step-log", "true", "--no-warnings", "true", "--time-to-teleport", "300",
           "--collision.action", "warn", "--collision.check-junctions", "true",
           "--tripinfo-output", str(tripinfo), "--waiting-time-memory", "10000",
           "--end", str(demand.duration + drain)]
    label = f"sf-{os.getpid()}-{controller_kind}-{load}-{seed}"
    if libsumo:
        tc.start(cmd)
    else:
        tc.start(cmd, label=label)
        tc.switch(label)
    in_lanes = sorted({l.in_lane for l in plan.links})
    lane_app = {l: l.split("_")[0] for l in in_lanes}
    lane_len = {l: tc.lane.getLength(l) for l in in_lanes}
    if trace:
        trace.begin(net, plan, plan_name, sc, controller_kind, load, seed)
    collisions = teleports = conflict_steps = 0
    q_sum = {a: 0.0 for a in "NESW"}
    q_max = 0
    q_total_sum = 0.0
    q_samples = 0
    states: list[tuple[float, str]] = []
    state = sup.state
    tc.trafficlight.setRedYellowGreenState(TLS_ID, state)
    t = 0.0
    try:
        while True:
            tc.simulationStep()
            t = tc.simulation.getTime()
            # независимая проверка фактического сигнала в SUMO
            actual = tc.trafficlight.getRedYellowGreenState(TLS_ID)
            if plan.conflicting_greens(actual):
                conflict_steps += 1
            if not states or states[-1][1] != actual:
                states.append((t - step, actual))
            collisions += tc.simulation.getCollidingVehiclesNumber()
            teleports += tc.simulation.getStartingTeleportNumber()
            # наблюдение
            queue, wait, appr = {}, {}, {}
            for l in in_lanes:
                queue[l] = tc.lane.getLastStepHaltingNumber(l)
                wait[l] = tc.lane.getWaitingTime(l)
                n = 0
                for v in tc.lane.getLastStepVehicleIDs(l):
                    if tc.vehicle.getSpeed(v) > 0.1 and lane_len[l] - tc.vehicle.getLanePosition(v) <= DETECTOR_M:
                        n += 1
                appr[l] = n
            if WARMUP <= t <= demand.duration:
                per = {a: 0 for a in "NESW"}
                for l, qv in queue.items():
                    per[lane_app[l]] += qv
                for a in per:
                    q_sum[a] += per[a]
                q_max = max(q_max, *per.values())
                q_total_sum += sum(per.values())
                q_samples += 1
            if trace:
                trace.frame(tc, t, sup)
            obs = Observation(time=t, queue=queue, wait=wait, approaching=appr)
            state = tick(sup, ctrl, obs, step)
            tc.trafficlight.setRedYellowGreenState(TLS_ID, state)
            if t >= demand.duration and tc.simulation.getMinExpectedNumber() == 0:
                break
            if t >= demand.duration + drain:
                break
    finally:
        tc.close()
    trips = _read_tripinfo(tripinfo)
    measured = [x for x in trips if WARMUP <= x["depart"] < demand.duration]
    durations = _stage_durations(states, step)
    res = RunResult(
        scenario=sc.id, controller=controller_kind, load=load, seed=seed, plan=plan_name, demand_vehicles=n_demand,
        completed=len(trips), unfinished=n_demand - len(trips),
        mean_wait=round(statistics.fmean(x["wait"] for x in measured), 2) if measured else None,
        mean_time_loss=round(statistics.fmean(x["loss"] for x in measured), 2) if measured else None,
        mean_queue=round(q_total_sum / q_samples, 2) if q_samples else 0.0,
        max_queue_approach=q_max,
        queue_by_approach={a: round(v / q_samples, 2) if q_samples else 0.0 for a, v in q_sum.items()},
        collisions=collisions, teleports=teleports, conflict_steps=conflict_steps, switches=sup.switches,
        min_green_seen=durations["green"], min_yellow_seen=durations["yellow"], min_allred_seen=durations["allred"],
        sim_end=t, measured_trips=len(measured),
        fixed_cycle={"greens": fixed_greens} if controller_kind == "fixed" else None,
        states=states if keep_states else [],
    )
    if trace:
        trace.end(asdict(res) | {"states": []})
    return res


def _read_tripinfo(path: Path) -> list[dict]:
    if not path.exists():
        return []
    root = ET.parse(path).getroot()
    return [{"id": t.get("id"), "depart": float(t.get("depart")), "wait": float(t.get("waitingTime")),
             "loss": float(t.get("timeLoss")), "duration": float(t.get("duration"))} for t in root.findall("tripinfo")]


def classify(state: str) -> str:
    if "G" in state or "g" in state:
        return "green"
    if "y" in state:
        return "yellow"
    return "allred"


def _stage_durations(states: list[tuple[float, str]], step: float) -> dict[str, float | None]:
    """Минимальная фактическая длительность каждой стадии в истории сигнала (без последней, незавершённой)."""
    out: dict[str, float | None] = {"green": None, "yellow": None, "allred": None}
    for (t0, s), (t1, _) in zip(states, states[1:]):
        k = classify(s)
        d = round(t1 - t0, 3)
        out[k] = d if out[k] is None else min(out[k], d)
    return out
