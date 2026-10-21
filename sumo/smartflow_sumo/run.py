"""Один прогон SUMO под управлением контроллера через TraCI.

Связь с SUMO — только здесь: наблюдения из TraCI → контроллер (control.py) → страж → сигнал в SUMO.
Независимые проверки каждый шаг: фактическое состояние светофора в SUMO сверяется с матрицей
конфликтов сети и с тем, что было задано; считаются столкновения и телепортации.

Безопасность при сбоях:
  - сбой контроллера или датчиков → SafeController переходит на резервный фиксированный план;
  - в SUMO горит не то, что задано (чужое или неизвестное состояние), или конфликтующие зелёные →
    немедленно «все красные», страж начинает переход заново (safety override);
  - потеря связи с SUMO → SimulatorConnectionError с понятным текстом (прогон не зависает).
Для проверки этих случаев есть Faults — внедрение неисправностей (используется только в тестах).
"""
from __future__ import annotations

import os
import re
import statistics
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .build import BUILD_DIR, TLS_ID, Demand, Scenario, build_net, make_plan, sumo_bin, write_routes
from .control import (AdaptiveController, AdaptiveParams, Controller, Decision, FixedTimeController, Observation, SafeController,
                      SignalPlan, SignalSupervisor, Timing, tick)
from .trace import TraceRecorder

#: зона детектора перед стоп-линией, м (≈ 2 с хода при 50 км/ч): пустая зона = разрыв потока
DETECTOR_M = 30.0
WARMUP = 300.0


class SimulatorConnectionError(RuntimeError):
    """Связь с SUMO потеряна: управлять нечем, прогон прерван."""


@dataclass
class Faults:
    """Внедрение неисправностей для тестов крайних случаев. Время — секунды модели."""
    #: с этого момента датчики полос подхода sensor_approach отдают «нет данных»
    sensor_fail_at: float | None = None
    sensor_approach: str = "N"
    #: с этого момента основной контроллер бросает исключение
    controller_fail_at: float | None = None
    #: в этот момент в SUMO записывается чужое состояние светофора (например, конфликтующие зелёные)
    foreign_state_at: float | None = None
    foreign_state: str | None = None
    #: закрытые полосы: id полосы → с какого момента (легковым запрещено)
    closed_lanes: dict[str, float] = field(default_factory=dict)
    #: в этот момент процесс SUMO аварийно завершается
    kill_at: float | None = None


class _FailingController:
    """Обёртка для теста: после момента fail_at основной контроллер бросает исключение."""

    def __init__(self, inner: Controller, fail_at: float):
        self.inner, self.fail_at = inner, fail_at
        self.name = inner.name
        self.last_reason = ""

    def request(self, phase, green_elapsed, obs, plan):
        if obs.time >= self.fail_at:
            raise RuntimeError("внедрённый сбой контроллера")
        k = self.inner.request(phase, green_elapsed, obs, plan)
        self.last_reason = self.inner.last_reason
        return k


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
    #: 95-й перцентиль времени поездки (от въезда в сеть до выезда), с
    p95_travel_time: float | None = None
    #: суммарное ожидание всех измеренных поездок, авт·ч
    total_wait_veh_h: float | None = None
    #: среднее число остановок на поездку (waitingCount в tripinfo SUMO)
    mean_stops: float | None = None
    #: пропускная способность: машин, выехавших за время спроса после разогрева, авт/ч
    throughput_veh_h: float | None = None
    #: среднее ожидание по подходам и наибольшее ожидание одной машины по подходам, с
    wait_by_approach: dict = field(default_factory=dict)
    max_wait_by_approach: dict = field(default_factory=dict)
    #: смены фаз с причинами
    decisions: list = field(default_factory=list, repr=False)
    decision_reasons: dict = field(default_factory=dict)
    #: переход на резервный план: момент и причина
    fallback_at: float | None = None
    fallback_reason: str | None = None
    #: шаги, на которых в SUMO было не то состояние, что задано, и включались «все красные»
    safety_overrides: int = 0
    fixed_cycle: dict | None = None
    states: list = field(default_factory=list, repr=False)


def adaptive_limits(fixed_greens: list[float] | None) -> AdaptiveParams:
    """Пределы зелёного адаптивного контроллера: 1,5 × зелёного расчётного плана, но не меньше 15 с.

    Так обычно задают максимум для актуированного регулирования: от расчётного плана, а не подбором.
    """
    if not fixed_greens:
        return AdaptiveParams()
    return AdaptiveParams(max_green_by_phase=tuple(max(15.0, round(1.5 * g)) for g in fixed_greens))


def make_controller(kind: str, plan: SignalPlan, fixed_greens: list[float] | None, faults: Faults | None = None) -> SafeController:
    """Контроллер в безопасной обёртке: резерв — фиксированный план (тот же, что у базового контроллера)."""
    if not fixed_greens:
        raise ValueError("нужны длительности зелёного фиксированного плана (он же — резерв)")
    if kind == "fixed":
        primary: Controller = FixedTimeController(fixed_greens)
    elif kind == "adaptive":
        primary = AdaptiveController(adaptive_limits(fixed_greens))
    else:
        raise ValueError(f"неизвестный контроллер {kind}")
    if faults and faults.controller_fail_at is not None:
        primary = _FailingController(primary, faults.controller_fail_at)
    return SafeController(primary, FixedTimeController(fixed_greens))


def _traci(libsumo: bool):
    if libsumo:
        import libsumo as tc  # noqa: N813
        return tc
    import traci as tc
    return tc


def run(sc: Scenario, controller_kind: str, load: str, demand: Demand, seed: int, *, timing: Timing = Timing(),
        fixed_greens: list[float] | None = None, drain: float = 1800.0, step: float = 1.0, libsumo: bool = False,
        trace: TraceRecorder | None = None, keep_states: bool = False, work_dir: Path | None = None,
        faults: Faults | None = None) -> RunResult:
    net = BUILD_DIR / sc.id / "net.net.xml"
    if not net.exists():
        build_net(sc)
    plan_name, plan = make_plan(net, sc)
    work = Path(work_dir or tempfile.mkdtemp(prefix="sf-sumo-"))
    routes = work / f"routes_{load}_{seed}.rou.xml"
    n_demand = write_routes(sc, demand, seed, routes)
    tripinfo = work / f"tripinfo_{controller_kind}_{load}_{seed}.xml"
    ctrl = make_controller(controller_kind, plan, fixed_greens, faults)
    sup = SignalSupervisor(plan, timing)
    decisions: list[Decision] = []
    overrides = 0
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
    from traci.exceptions import FatalTraCIError, TraCIException  # noqa: PLC0415 — нужен и для libsumo-режима
    lost = (FatalTraCIError, TraCIException, ConnectionError, OSError)
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
    f = faults or Faults()
    closed = dict(f.closed_lanes)
    try:
        while True:
            if f.kill_at is not None and t >= f.kill_at and not libsumo:
                tc.getConnection(label)._process.kill()  # внедрённая авария SUMO
                f.kill_at = None
            try:
                tc.simulationStep()
            except lost as e:
                raise SimulatorConnectionError(
                    f"связь с SUMO потеряна на t={t:.0f} с ({type(e).__name__}); прогон прерван, "
                    f"последний заданный сигнал {state}") from e
            t = tc.simulation.getTime()
            for lane, since in list(closed.items()):
                if t >= since:
                    tc.lane.setDisallowed(lane, ["passenger"])
                    del closed[lane]
            # независимая проверка фактического сигнала в SUMO
            actual = tc.trafficlight.getRedYellowGreenState(TLS_ID)
            if plan.conflicting_greens(actual):
                conflict_steps += 1
            if not states or states[-1][1] != actual:
                states.append((t - step, actual))
            if actual != state:
                # в SUMO горит не то, что задано: немедленно «все красные», переход начинается заново
                overrides += 1
                state = "r" * len(plan.links)
                tc.trafficlight.setRedYellowGreenState(TLS_ID, state)
                sup.stage, sup.elapsed = "allred", 0.0
                states.append((t, state))
                decisions.append(Decision(t, sup.phase, sup.next_phase, "страж",
                                          f"в SUMO сигнал «{actual}» вместо заданного — включены «все красные»"))
            collisions += tc.simulation.getCollidingVehiclesNumber()
            teleports += tc.simulation.getStartingTeleportNumber()
            # наблюдение
            queue: dict[str, int | None] = {}
            wait: dict[str, float | None] = {}
            appr: dict[str, int | None] = {}
            for l in in_lanes:
                if f.sensor_fail_at is not None and t >= f.sensor_fail_at and lane_app[l] == f.sensor_approach:
                    queue[l] = wait[l] = appr[l] = None  # датчик не отвечает
                    continue
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
                    per[lane_app[l]] += qv or 0
                for a in per:
                    q_sum[a] += per[a]
                q_max = max(q_max, *per.values())
                q_total_sum += sum(per.values())
                q_samples += 1
            if trace:
                trace.frame(tc, t, sup)
            obs = Observation(time=t, queue=queue, wait=wait, approaching=appr)
            state = tick(sup, ctrl, obs, step, decisions)
            tc.trafficlight.setRedYellowGreenState(TLS_ID, state)
            if f.foreign_state_at is not None and t >= f.foreign_state_at:
                tc.trafficlight.setRedYellowGreenState(TLS_ID, f.foreign_state or "G" * len(plan.links))  # чужая команда
                f.foreign_state_at = None
            if t >= demand.duration and tc.simulation.getMinExpectedNumber() == 0:
                break
            if t >= demand.duration + drain:
                break
    finally:
        try:
            tc.close()
        except Exception:  # noqa: BLE001 — соединение уже разорвано
            pass
    trips = _read_tripinfo(tripinfo)
    measured = [x for x in trips if WARMUP <= x["depart"] < demand.duration]
    durations = _stage_durations(states, step)
    by_app: dict[str, list[float]] = {a: [] for a in "NESW"}
    for x in measured:
        by_app[x["id"][0]].append(x["wait"])
    arrived = [x for x in trips if WARMUP <= x["arrival"] <= demand.duration]
    reasons: dict[str, int] = {}
    for d in decisions:
        # категория причины: текст до двоеточия, без чисел (например, «максимум зелёного фазы»)
        key = re.sub(r"\s+\d+(?:[.,]\d+)?\s*с$", "", d.reason.split(":")[0].split(";")[0].strip())
        reasons[key] = reasons.get(key, 0) + 1
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
        p95_travel_time=_pct([x["duration"] for x in measured], 0.95),
        total_wait_veh_h=round(sum(x["wait"] for x in measured) / 3600, 2) if measured else None,
        mean_stops=round(statistics.fmean(x["stops"] for x in measured), 2) if measured else None,
        throughput_veh_h=round(len(arrived) / max(1.0, demand.duration - WARMUP) * 3600, 1) if demand.duration > WARMUP else None,
        wait_by_approach={a: round(statistics.fmean(v), 2) for a, v in by_app.items() if v},
        max_wait_by_approach={a: round(max(v), 1) for a, v in by_app.items() if v},
        decisions=[asdict(d) for d in decisions], decision_reasons=reasons,
        fallback_at=ctrl.failed_at, fallback_reason=ctrl.failure, safety_overrides=overrides,
        fixed_cycle={"greens": fixed_greens} if controller_kind == "fixed" else None,
        states=states if keep_states else [],
    )
    if trace:
        w0, w1 = trace.window
        trace.end(asdict(res) | {"states": [], "decisions": []})
        trace.data["decisions"] = [d for d in res.decisions if w0 <= d["time"] <= w1]
    return res


def _read_tripinfo(path: Path) -> list[dict]:
    if not path.exists():
        return []
    root = ET.parse(path).getroot()
    return [{"id": t.get("id"), "depart": float(t.get("depart")), "arrival": float(t.get("arrival")),
             "wait": float(t.get("waitingTime")), "stops": int(t.get("waitingCount", 0)),
             "loss": float(t.get("timeLoss")), "duration": float(t.get("duration"))} for t in root.findall("tripinfo")]


def _pct(values: list[float], p: float) -> float | None:
    """Перцентиль с линейной интерполяцией; None — нет данных."""
    if not values:
        return None
    a = sorted(values)
    k = (len(a) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(a) - 1)
    return round(a[lo] + (a[hi] - a[lo]) * (k - lo), 2)


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
