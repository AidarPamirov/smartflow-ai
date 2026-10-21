"""Коридор из нескольких связанных перекрёстков в SUMO (проспект Чуй).

Зачем: на одном перекрёстке адаптивный контроллер уменьшает задержку, но в сети очередь одного светофора может
дойти до соседнего (spillback), а «улучшение» одного узла — ухудшить другой. Здесь сравниваются три способа
управления на одних и тех же маршрутах:
  fixed           — фиксированный план по Уэбстеру на каждом перекрёстке, независимо, без сдвигов;
  coordinated     — фиксированные планы с общим циклом и сдвигами «зелёной волны» для движения на восток;
  adaptive        — независимый адаптивный контроллер (тот же, что на одиночном перекрёстке) на каждом узле;
  coord_adaptive  — адаптивный с координацией: цикл и сдвиги «волны», но пустые фазы пропускаются, а поперечные
                    фазы заканчиваются при разрыве потока (control.CoordinatedActuatedController).
Измеряется общая задержка сети, время проезда коридора, очереди у каждого узла, наибольшее заполнение участков
между перекрёстками и время, когда очередь на участке дотягивается до предыдущего перекрёстка (распространение очередей).

Цель — найти лучший вариант среди проверенных сценариев, а не «оптимальное управление городом».
Алгоритмы управления — те же модули control.py, что и в одиночном эксперименте.
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import hashlib
import json
import math
import os
import random
import re
import statistics
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import SimpleNamespace

from .build import BUILD_DIR, SCENARIO_DIR, candidate_plans, movements_of, read_links_and_foes, sumo_bin, target, webster_greens
from .control import (AdaptiveController, CoordinatedActuatedController, Decision, FixedTimeController, Observation, SafeController,
                      SignalPlan, SignalSupervisor, Timing, UnsafePlanError, tick)
from .run import DETECTOR_M, WARMUP, SimulatorConnectionError, _pct, adaptive_limits, box_blocked, internal_lanes
from .stats import describe, paired

DIRS = "NESW"
V_FREE = 50 / 3.6  # скорость «зелёной волны», м/с
STORAGE_PER_VEH = 7.0  # м полосы на стоящую машину (длина 4,5 + зазор 2,5)
SPILL_ZONE_M = 20.0  # очередь «дошла до предыдущего перекрёстка», если стоящая машина в первых 20 м участка


# ───────────── описание коридора ─────────────

@dataclass
class CNode:
    id: str
    title: str
    x: float
    lanes_in: dict[str, list[str]]  # сторона → назначение полос слева направо
    lanes_out: dict[str, int]
    bearings: dict[str, float]  # стороны поперечных улиц → азимут
    osm_site: str


@dataclass
class Corridor:
    id: str
    title: str
    nodes: list[CNode]
    seg_lanes: dict[tuple[str, str], int]  # (A, B) → полос в каждую сторону между соседними точками
    speed: float
    lane_width: float
    end_length: float
    arm_length: float
    raw: dict

    @property
    def chain(self) -> list[str]:
        return ["W_END"] + [n.id for n in self.nodes] + ["E_END"]

    def node(self, nid: str) -> CNode:
        return next(n for n in self.nodes if n.id == nid)


def load_corridor(name: str = "chui-corridor") -> Corridor:
    raw = json.loads((SCENARIO_DIR / f"{name}.json").read_text(encoding="utf-8"))
    seg = {}
    for s in raw["segments"]:
        a, b = s["between"]
        seg[(a, b)] = seg[(b, a)] = int(s["lanes"])
    chain = ["W_END"] + [n["id"] for n in raw["nodes"]] + ["E_END"]
    nodes = []
    for i, n in enumerate(raw["nodes"]):
        lanes_in = {d: list(v) for d, v in n["lanes_in"].items()}
        lanes_out = {"W": seg[(chain[i], chain[i + 1])], "E": seg[(chain[i + 1], chain[i + 2])]}
        bearings = {}
        for d, a in n["arms"].items():
            lanes_in[d] = list(a["lanes_in"])
            lanes_out[d] = int(a["lanes_out"])
            bearings[d] = float(a["bearing"])
        for d in ("W", "E"):
            want = seg[(chain[i], chain[i + 1])] if d == "W" else seg[(chain[i + 1], chain[i + 2])]
            if len(lanes_in[d]) != want:
                raise ValueError(f"{n['id']}: у подхода {d} {len(lanes_in[d])} полос, а у участка {want}")
        nodes.append(CNode(n["id"], n["title"], float(n["x"]), lanes_in, lanes_out, bearings, n["osm_site"]))
    return Corridor(raw["id"], raw["title"], nodes, seg, raw["speed_kmh"] / 3.6, raw["lane_width_m"], raw["end_length_m"],
                    raw["arm_length_m"], raw)


# ───────────── сеть ─────────────

def edge_in(c: Corridor, k: int, d: str) -> str:
    """Ребро, по которому въезжают в узел k со стороны d."""
    ch = c.chain
    if d == "W":
        return f"{ch[k]}_to_{ch[k + 1]}"
    if d == "E":
        return f"{ch[k + 2]}_to_{ch[k + 1]}"
    return f"{c.nodes[k].id}_{d}_in"


def edge_out(c: Corridor, k: int, d: str) -> str:
    """Ребро, по которому выезжают из узла k в сторону d."""
    ch = c.chain
    if d == "E":
        return f"{ch[k + 1]}_to_{ch[k + 2]}"
    if d == "W":
        return f"{ch[k + 1]}_to_{ch[k]}"
    return f"{c.nodes[k].id}_{d}_out"


def dir_maps(c: Corridor, k: int) -> tuple[dict[str, str], dict[str, str]]:
    n = c.nodes[k]
    ins = {edge_in(c, k, d): d for d in n.lanes_in}
    outs = {edge_out(c, k, d): d for d in n.lanes_out}
    return ins, outs


def write_plain_xml(c: Corridor, out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    nod, edg, con = ET.Element("nodes"), ET.Element("edges"), ET.Element("connections")
    xs = {n.id: n.x for n in c.nodes}
    xs["W_END"] = c.nodes[0].x - c.end_length
    xs["E_END"] = c.nodes[-1].x + c.end_length
    for nid, x in xs.items():
        if nid.endswith("_END"):
            ET.SubElement(nod, "node", id=nid, x=f"{x:.2f}", y="0", type="priority")
        else:
            ET.SubElement(nod, "node", id=nid, x=f"{x:.2f}", y="0", type="traffic_light", tl=nid)
    common = dict(speed=f"{c.speed:.2f}", width=str(c.lane_width), priority="2")
    ch = c.chain
    for a, b in zip(ch, ch[1:]):
        lanes = c.seg_lanes[(a, b)]
        ET.SubElement(edg, "edge", id=f"{a}_to_{b}", **{"from": a, "to": b}, numLanes=str(lanes), **common)
        ET.SubElement(edg, "edge", id=f"{b}_to_{a}", **{"from": b, "to": a}, numLanes=str(lanes), **common)
    for n in c.nodes:
        for d, bearing in n.bearings.items():
            b = math.radians(bearing)
            ex, ey = n.x + c.arm_length * math.sin(b), c.arm_length * math.cos(b)
            end = f"{n.id}_{d}_end"
            ET.SubElement(nod, "node", id=end, x=f"{ex:.2f}", y=f"{ey:.2f}", type="priority")
            ET.SubElement(edg, "edge", id=f"{n.id}_{d}_in", **{"from": end, "to": n.id}, numLanes=str(len(n.lanes_in[d])), **common)
            ET.SubElement(edg, "edge", id=f"{n.id}_{d}_out", **{"from": n.id, "to": end}, numLanes=str(n.lanes_out[d]), **common)
    for k, n in enumerate(c.nodes):
        for d, uses in n.lanes_in.items():
            m = len(uses)
            by_turn: dict[str, list[int]] = {"L": [], "T": [], "R": []}
            for pos, use in enumerate(uses):
                for t in use:
                    by_turn[t].append(m - 1 - pos)  # полосы слева направо → индекс SUMO (0 — правая)
            for t, lanes in by_turn.items():
                if not lanes:
                    continue
                ex = target(d, t)
                if ex not in n.lanes_out:
                    raise ValueError(f"{n.id}: манёвр {d}{t} ведёт в несуществующий выезд {ex}")
                out_n = n.lanes_out[ex]
                for i, fl in enumerate(sorted(lanes)):
                    tl = max(out_n - len(lanes) + i, 0) if t == "L" else min(i, out_n - 1)
                    ET.SubElement(con, "connection", **{"from": edge_in(c, k, d), "to": edge_out(c, k, ex)}, fromLane=str(fl), toLane=str(tl))
    files = {}
    for name, root in (("nod", nod), ("edg", edg), ("con", con)):
        ET.indent(root)
        p = out / f"plain.{name}.xml"
        ET.ElementTree(root).write(p, encoding="utf-8", xml_declaration=True)
        files[name] = p
    return files


def build_corridor_net(c: Corridor, out: Path | None = None) -> Path:
    out = out or BUILD_DIR / c.id
    files = write_plain_xml(c, out)
    net = out / "net.net.xml"
    cmd = [sumo_bin("netconvert"), "--node-files", str(files["nod"]), "--edge-files", str(files["edg"]),
           "--connection-files", str(files["con"]), "--output-file", str(net),
           "--no-turnarounds", "true", "--junctions.corner-detail", "8", "--tls.default-type", "static",
           "--offset.disable-normalization", "true", "--no-warnings", "true"]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return net


def corridor_plans(c: Corridor, net: Path) -> list[tuple[str, SignalPlan]]:
    """План фаз каждого узла: те же правила, что у одиночного перекрёстка, проверка по матрице конфликтов SUMO."""
    out = []
    for k, n in enumerate(c.nodes):
        ins, outs = dir_maps(c, k)
        links, foes = read_links_and_foes(net, n.id, in_dir=ins.__getitem__, out_dir=outs.__getitem__)
        arms = {d: SimpleNamespace(lanes_in=tuple(n.lanes_in.get(d, ()))) for d in DIRS}
        errors = []
        for name, phases in candidate_plans(movements_of(links), SimpleNamespace(arms=arms)):
            try:
                out.append((name, SignalPlan(links, phases, foes)))
                break
            except UnsafePlanError as e:
                errors.append(f"{name}: {e}")
        else:
            raise UnsafePlanError(f"{n.id}: ни один план не прошёл проверку: " + "; ".join(errors))
    return out


# ───────────── спрос ─────────────

TURNS_MAIN = {"L": 0.10, "T": 0.80, "R": 0.10}
TURNS_CROSS = {"L": 0.35, "T": 0.30, "R": 0.35}

#: интенсивность на въездах, авт/ч: концы проспекта и поперечные улицы каждого узла (синтетика)
LOADS: dict[str, dict[str, float]] = {
    "low": {"W_END": 520, "E_END": 520, "INT_S": 90, "MAN_N": 290, "MAN_S": 140, "KUL_N": 90, "KUL_S": 170, "BEI_N": 70, "BEI_S": 70},
    "medium": {"W_END": 720, "E_END": 720, "INT_S": 140, "MAN_N": 420, "MAN_S": 200, "KUL_N": 130, "KUL_S": 260, "BEI_N": 110, "BEI_S": 110},
    "high": {"W_END": 900, "E_END": 900, "INT_S": 190, "MAN_N": 530, "MAN_S": 260, "KUL_N": 180, "KUL_S": 350, "BEI_N": 140, "BEI_S": 140},
}
DESIGN_LOAD = "medium"

#: стресс-сценарий «ДТП на выезде»: сильный поток на восток, выезд за Бейшеналиевой почти перекрыт ~5 мин.
#: Нужен, чтобы проверить распространение очереди до соседнего перекрёстка (при обычных нагрузках его нет).
INCIDENT = {"title": "ДТП на выезде на восток", "flows": {"W_END": 1700, "E_END": 300}, "closures": [("BEI_to_E_END", 140.0, 435.0)],
            "duration": 900.0, "teleport_s": 900.0}  # в пробке из-за ДТП машины ждут дольше обычного порога «застревания» SUMO


def allowed(n: CNode, d: str) -> list[str]:
    return sorted({t for use in n.lanes_in[d] for t in use}, key="LTR".index)


def shares(n: CNode, d: str) -> dict[str, float]:
    base = TURNS_MAIN if d in "WE" else TURNS_CROSS
    al = allowed(n, d)
    tot = sum(base[t] for t in al)
    return {t: base[t] / tot for t in al}


def entry_point(c: Corridor, entry: str) -> tuple[int, str]:
    if entry == "W_END":
        return 0, "W"
    if entry == "E_END":
        return len(c.nodes) - 1, "E"
    nid, d = entry.split("_")
    return [n.id for n in c.nodes].index(nid), d


def expected_flows(c: Corridor, flows: dict[str, float]) -> dict[tuple[int, str, str], float]:
    """Ожидаемый поток манёвра (узел, подход, поворот), авт/ч: распространение по вероятностям поворотов."""
    out: dict[tuple[int, str, str], float] = {}
    stack = [(*entry_point(c, e), q) for e, q in flows.items() if q > 0]
    while stack:
        k, d, q = stack.pop()
        if q < 1e-6:
            continue
        for t, p in shares(c.nodes[k], d).items():
            f = q * p
            out[(k, d, t)] = out.get((k, d, t), 0.0) + f
            ex = target(d, t)
            if ex == "E" and k + 1 < len(c.nodes):
                stack.append((k + 1, "W", f))
            elif ex == "W" and k > 0:
                stack.append((k - 1, "E", f))
    return out


def node_lane_flows(c: Corridor, k: int, flows: dict[str, float]) -> dict[str, float]:
    """Поток по входным полосам узла k: поток манёвра делится поровну между полосами, где он разрешён."""
    ex = expected_flows(c, flows)
    n = c.nodes[k]
    out: dict[str, float] = {}
    for d, uses in n.lanes_in.items():
        m = len(uses)
        for t in allowed(n, d):
            lanes = [m - 1 - pos for pos, use in enumerate(uses) if t in use]
            for l in lanes:
                key = f"{edge_in(c, k, d)}_{l}"
                out[key] = out.get(key, 0.0) + ex.get((k, d, t), 0.0) / len(lanes)
    return out


def write_routes(c: Corridor, flows: dict[str, float], duration: float, seed: int, path: Path) -> dict[str, tuple[str, str]]:
    """Пуассоновские прибытия на каждом въезде, маршрут — случайные повороты по долям на каждом узле.
    Одинаковый seed → одинаковый файл для любого контроллера. Возвращает id машины → (въезд, выезд)."""
    rng = random.Random(seed)
    vehicles = []
    for entry in sorted(flows):
        q = flows[entry]
        if q <= 0:
            continue
        t = rng.expovariate(q / 3600)
        while t < duration:
            k, d = entry_point(c, entry)
            edges = [edge_in(c, k, d)]
            while True:
                sh = shares(c.nodes[k], d)
                u, acc, turn = rng.random(), 0.0, list(sh)[-1]
                for tt, p in sh.items():
                    acc += p
                    if u < acc:
                        turn = tt
                        break
                ex = target(d, turn)
                edges.append(edge_out(c, k, ex))
                if ex == "E" and k + 1 < len(c.nodes):
                    k, d = k + 1, "W"
                elif ex == "W" and k > 0:
                    k, d = k - 1, "E"
                else:
                    break
            vehicles.append((round(t, 2), entry, edges))
            t += rng.expovariate(q / 3600)
    vehicles.sort(key=lambda v: v[0])
    root = ET.Element("routes")
    ET.SubElement(root, "vType", id="car", length="4.5", minGap="2.5", accel="2.6", decel="4.5", sigma="0.5", maxSpeed="16.7", tau="1.0")
    od: dict[str, tuple[str, str]] = {}
    for i, (t, entry, edges) in enumerate(vehicles):
        vid = f"{entry}.{i}"
        v = ET.SubElement(root, "vehicle", id=vid, type="car", depart=f"{t:.2f}", departLane="best", departSpeed="max")
        ET.SubElement(v, "route", edges=" ".join(edges))
        od[vid] = (entry, edges[-1])
    ET.indent(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return od


# ───────────── планы: независимые и согласованные ─────────────

def fixed_plans(c: Corridor, plans: list[tuple[str, SignalPlan]], timing: Timing) -> list[dict]:
    """Фиксированный план каждого узла по Уэбстеру на расчётную нагрузку."""
    out = []
    lost = timing.yellow + timing.all_red
    for k, (_, plan) in enumerate(plans):
        cycle, greens = webster_greens(plan, node_lane_flows(c, k, LOADS[DESIGN_LOAD]), lost_per_phase=lost, min_green=timing.min_green)
        out.append({"node": c.nodes[k].id, "greens": greens, "cycle": round(sum(greens) + plan.n * lost, 1), "webster_cycle": round(cycle, 1),
                    "phases": [p.name for p in plan.phases], "offset": 0.0})
    return out


def coordinated_plans(c: Corridor, plans: list[tuple[str, SignalPlan]], fixed: list[dict], timing: Timing) -> list[dict]:
    """Общий цикл (наибольший из узлов) и сдвиги так, чтобы зелёный для прямого движения на восток начинался
    по мере подхода «волны» со скоростью V_FREE от первого узла."""
    lost = timing.yellow + timing.all_red
    C = max(f["cycle"] for f in fixed)
    out = []
    for k, ((_, plan), f) in enumerate(zip(plans, fixed)):
        eff_old = sum(f["greens"])
        eff_new = C - plan.n * lost
        greens = [float(max(timing.min_green, round(g * eff_new / eff_old))) for g in f["greens"]]
        greens[0] += C - plan.n * lost - sum(greens)  # остаток округления — первой фазе
        east = next((i for i, ph in enumerate(plan.phases) if any(m.approach == "W" and m.turn == "T" for m in ph.movements)), 0)
        start_east = sum(greens[i] + lost for i in range(east))
        arrive = (c.nodes[k].x - c.nodes[0].x) / V_FREE
        offset = (arrive - start_east) % C  # момент начала цикла относительно t = 0
        out.append({"node": c.nodes[k].id, "greens": greens, "cycle": C, "phases": f["phases"], "offset": round(offset, 1), "east_phase": east})
    return out


def place_in_cycle(greens: list[float], timing: Timing, u: float) -> tuple[int, str, float]:
    """Фаза, стадия и прошедшее время в стадии для положения u (с) от начала цикла."""
    for k, g in enumerate(greens):
        if u < g:
            return k, "green", u
        u -= g
        if u < timing.yellow:
            return k, "yellow", u
        u -= timing.yellow
        if u < timing.all_red:
            return k, "allred", u
        u -= timing.all_red
    return 0, "green", 0.0


# ───────────── прогон ─────────────

@dataclass
class CorridorResult:
    corridor: str
    controller: str
    load: str
    seed: int
    demand_vehicles: int
    completed: int
    unfinished: int
    mean_wait: float | None
    mean_time_loss: float | None
    p95_travel_time: float | None
    total_time_loss_veh_h: float | None
    mean_stops: float | None
    throughput_veh_h: float | None
    #: среднее время проезда всего коридора (с запада на восток и обратно), с
    through_time_eb: float | None
    through_time_wb: float | None
    through_stops_eb: float | None
    through_stops_wb: float | None
    #: средняя очередь у каждого узла (стоящие на его въездах), авт
    queue_by_node: dict
    #: сколько секунд хвост очереди на участке стоял у самого предыдущего перекрёстка (в первых SPILL_ZONE_M м)
    spill_seconds: dict
    #: наибольшая доля вместимости участка, занятая стоящими машинами (0…1)
    max_fill: dict
    collisions: int
    teleports: int
    conflict_steps: int
    safety_overrides: int
    fallbacks: int
    switches: int
    decision_reasons: dict
    plans: list = field(default_factory=list)
    sim_end: float = 0.0
    #: секунды продления «все красные» из-за машины, стоящей в зоне перекрёстка (сумма по узлам)
    clearance_hold_s: float = 0.0
    #: подробности столкновений (если были): время, тип, полоса, скорости — для разбора
    collision_details: list = field(default_factory=list)
    #: средняя очередь (стоящих машин) по узлам и подходам: узел → сторона → авт
    queue_by_approach: dict = field(default_factory=dict)
    #: среднее ожидание поездок по въезду (W_END, E_END, MAN_N, …), с
    wait_by_entry: dict = field(default_factory=dict)
    #: среднее ожидание поездок с концов проспекта и с поперечных улиц, с
    main_wait: float | None = None
    side_wait: float | None = None


def run_corridor(c: Corridor, controller: str, load: str, seed: int, *, duration: float = 3600.0, drain: float = 1800.0,
                 timing: Timing = Timing(), flows: dict[str, float] | None = None, work_dir: Path | None = None,
                 closures: list[tuple[str, float, float]] = (), teleport_s: float = 300.0, routes_file: Path | None = None) -> CorridorResult:
    """Один прогон коридора. closures — перекрытия рёбер (id ребра, начало, конец, с): движение по всем полосам
    ребра почти останавливается, как при ДТП; нужно для проверки распространения очереди на соседний перекрёсток."""
    net = BUILD_DIR / c.id / "net.net.xml"
    if not net.exists():
        build_corridor_net(c)
    plans = corridor_plans(c, net)
    fixed = fixed_plans(c, plans, timing)
    work = Path(work_dir or tempfile.mkdtemp(prefix="sf-corr-"))
    flows = flows if flows is not None else LOADS[load]
    if routes_file is not None:  # общий файл маршрутов для всех способов управления
        routes = Path(routes_file)
        od = {v.get("id"): (v.get("id").rsplit(".", 1)[0], v.find("route").get("edges").split()[-1])
              for v in ET.parse(routes).getroot().findall("vehicle")}
    else:
        routes = work / f"corr_routes_{load}_{seed}.rou.xml"
        od = write_routes(c, flows, duration, seed, routes)
    tripinfo = work / f"corr_trip_{controller}_{load}_{seed}.xml"

    if controller not in CONTROLLERS:
        raise ValueError(f"неизвестный способ управления {controller}")
    used = coordinated_plans(c, plans, fixed, timing) if controller in ("coordinated", "coord_adaptive") else fixed
    lost = timing.yellow + timing.all_red
    ctrls, sups = [], []
    for k, (_, plan) in enumerate(plans):
        greens = used[k]["greens"]
        if controller == "adaptive":
            primary = AdaptiveController(adaptive_limits(fixed[k]["greens"]))
        elif controller == "coord_adaptive":
            primary = CoordinatedActuatedController(greens, used[k]["cycle"], used[k]["offset"], used[k]["east_phase"], lost, timing.min_green)
        else:
            primary = FixedTimeController(greens)
        ctrls.append(SafeController(primary, FixedTimeController(greens)))
        sup = SignalSupervisor(plan, timing)
        if used[k]["offset"]:
            cyc = used[k]["cycle"]
            ph, st, el = place_in_cycle(greens, timing, (-used[k]["offset"]) % cyc)
            sup.phase, sup.next_phase, sup.stage, sup.elapsed = ph, (ph + 1) % plan.n if st != "green" else ph, st, el
        sups.append(sup)

    import traci as tc
    from traci.exceptions import FatalTraCIError, TraCIException
    label = f"sf-corr-{os.getpid()}-{controller}-{load}-{seed}"
    cmd = [sumo_bin("sumo"), "-n", str(net), "-r", str(routes), "--step-length", "1", "--seed", str(seed),
           "--no-step-log", "true", "--no-warnings", "true", "--time-to-teleport", f"{teleport_s:g}",
           "--collision.action", "warn", "--collision.check-junctions", "true",
           "--tripinfo-output", str(tripinfo), "--waiting-time-memory", "10000", "--end", str(duration + drain)]
    tc.start(cmd, label=label)
    tc.switch(label)
    lanes_of = [sorted({l.in_lane for l in plan.links}) for _, plan in plans]
    boxes = [internal_lanes(net, n.id) for n in c.nodes]
    lane_len = {l: tc.lane.getLength(l) for ls in lanes_of for l in ls}
    internal = [f"{a}_to_{b}" for a, b in zip(c.chain[1:-1], c.chain[2:-1])] + [f"{b}_to_{a}" for a, b in zip(c.chain[1:-1], c.chain[2:-1])]
    storage = {e: tc.edge.getLaneNumber(e) * tc.lane.getLength(f"{e}_0") / STORAGE_PER_VEH for e in internal}
    spill = {e: 0 for e in internal}
    fill = {e: 0.0 for e in internal}
    q_sum = [0.0] * len(plans)
    q_app = [{d: 0.0 for d in c.nodes[k].lanes_in} for k in range(len(plans))]
    lane_dir = [{l: dir_maps(c, k)[0][l.rsplit("_", 1)[0]] for l in lanes} for k, lanes in enumerate([sorted({l.in_lane for l in plan.links}) for _, plan in plans])]
    q_n = 0
    collisions = teleports = conflicts = overrides = 0
    collision_log: list[dict] = []
    decisions: list[Decision] = []
    states = [sup.state for sup in sups]
    for k, n in enumerate(c.nodes):
        tc.trafficlight.setRedYellowGreenState(n.id, states[k])
    t = 0.0
    try:
        while True:
            try:
                tc.simulationStep()
            except (FatalTraCIError, TraCIException, ConnectionError, OSError) as e:
                raise SimulatorConnectionError(f"связь с SUMO потеряна на t={t:.0f} с ({type(e).__name__})") from e
            t = tc.simulation.getTime()
            for e, c0, c1 in closures:
                if t in (c0, c1):  # перекрытие: скорость почти ноль (маршруты остаются допустимыми), потом — как было
                    for i in range(tc.edge.getLaneNumber(e)):
                        tc.lane.setMaxSpeed(f"{e}_{i}", 0.01 if t == c0 else c.speed)
            n_col = tc.simulation.getCollidingVehiclesNumber()
            if n_col:
                collisions += n_col
                for col in tc.simulation.getCollisions():
                    collision_log.append({"t": t, "type": col.type, "lane": col.lane, "pos": round(col.pos, 1),
                                          "collider_speed": round(col.colliderSpeed, 2), "victim_speed": round(col.victimSpeed, 2)})
            teleports += tc.simulation.getStartingTeleportNumber()
            measuring = WARMUP <= t <= duration
            for k, (n, (_, plan)) in enumerate(zip(c.nodes, plans)):
                actual = tc.trafficlight.getRedYellowGreenState(n.id)
                if plan.conflicting_greens(actual):
                    conflicts += 1
                if actual != states[k]:
                    overrides += 1
                    states[k] = "r" * len(plan.links)
                    tc.trafficlight.setRedYellowGreenState(n.id, states[k])
                    sups[k].stage, sups[k].elapsed = "allred", 0.0
                queue, wait, appr = {}, {}, {}
                for l in lanes_of[k]:
                    queue[l] = tc.lane.getLastStepHaltingNumber(l)
                    wait[l] = tc.lane.getWaitingTime(l)
                    appr[l] = sum(1 for v in tc.lane.getLastStepVehicleIDs(l)
                                  if tc.vehicle.getSpeed(v) > 0.1 and lane_len[l] - tc.vehicle.getLanePosition(v) <= DETECTOR_M)
                if measuring:
                    q_sum[k] += sum(queue.values())
                    for l, qv in queue.items():
                        q_app[k][lane_dir[k][l]] += qv
                node_log: list[Decision] = []
                states[k] = tick(sups[k], ctrls[k], Observation(t, queue, wait, appr, box_blocked=sups[k].stage == "allred" and box_blocked(tc, boxes[k])),
                                 1.0, node_log)
                decisions += [Decision(d.time, d.from_phase, d.to_phase, f"{n.id}:{d.controller}", d.reason) for d in node_log]
                tc.trafficlight.setRedYellowGreenState(n.id, states[k])
            if measuring:
                q_n += 1
                for e in internal:
                    h = tc.edge.getLastStepHaltingNumber(e)
                    fill[e] = max(fill[e], h / storage[e])
                    if h and any(tc.vehicle.getSpeed(v) < 0.1 and tc.vehicle.getLanePosition(v) <= SPILL_ZONE_M
                                 for v in tc.edge.getLastStepVehicleIDs(e)):
                        spill[e] += 1
            if t >= duration and tc.simulation.getMinExpectedNumber() == 0:
                break
            if t >= duration + drain:
                break
    finally:
        try:
            tc.close()
        except Exception:  # noqa: BLE001
            pass
    trips = []
    if tripinfo.exists():
        for e in ET.parse(tripinfo).getroot().findall("tripinfo"):
            trips.append({"id": e.get("id"), "depart": float(e.get("depart")), "arrival": float(e.get("arrival")),
                          "wait": float(e.get("waitingTime")), "loss": float(e.get("timeLoss")), "duration": float(e.get("duration")),
                          "stops": int(e.get("waitingCount", 0))})
    measured = [x for x in trips if WARMUP <= x["depart"] < duration]
    eb = [x for x in measured if od[x["id"]] == ("W_END", c.chain[-2] + "_to_E_END")]
    wb = [x for x in measured if od[x["id"]] == ("E_END", c.chain[1] + "_to_W_END")]
    reasons: dict[str, int] = {}
    for d in decisions:
        key = re.sub(r"\s+\d+(?:[.,]\d+)?\s*с$", "", d.reason.split(":")[0].split(";")[0].strip())
        reasons[key] = reasons.get(key, 0) + 1
    by_entry: dict[str, list[float]] = {}
    for x in measured:
        by_entry.setdefault(od[x["id"]][0], []).append(x["wait"])
    main = [w for e, ws in by_entry.items() if e.endswith("_END") for w in ws]
    side = [w for e, ws in by_entry.items() if not e.endswith("_END") for w in ws]
    mean = lambda xs: round(statistics.fmean(xs), 2) if xs else None  # noqa: E731
    return CorridorResult(
        corridor=c.id, controller=controller, load=load, seed=seed, demand_vehicles=len(od), completed=len(trips),
        unfinished=len(od) - len(trips),
        mean_wait=mean([x["wait"] for x in measured]), mean_time_loss=mean([x["loss"] for x in measured]),
        p95_travel_time=_pct([x["duration"] for x in measured], 0.95),
        total_time_loss_veh_h=round(sum(x["loss"] for x in measured) / 3600, 2) if measured else None,
        mean_stops=mean([x["stops"] for x in measured]),
        throughput_veh_h=round(sum(1 for x in trips if WARMUP <= x["arrival"] <= duration) / (duration - WARMUP) * 3600, 1),
        through_time_eb=mean([x["duration"] for x in eb]), through_time_wb=mean([x["duration"] for x in wb]),
        through_stops_eb=mean([x["stops"] for x in eb]), through_stops_wb=mean([x["stops"] for x in wb]),
        queue_by_node={n.id: round(q_sum[k] / q_n, 2) if q_n else 0.0 for k, n in enumerate(c.nodes)},
        spill_seconds=spill, max_fill={e: round(v, 3) for e, v in fill.items()}, collisions=collisions, teleports=teleports, conflict_steps=conflicts, safety_overrides=overrides,
        fallbacks=sum(1 for x in ctrls if x.failed_at is not None), switches=sum(s.switches for s in sups),
        clearance_hold_s=round(sum(s.clearance_hold_s for s in sups), 1),
        decision_reasons=reasons, plans=used, sim_end=t, collision_details=collision_log,
        queue_by_approach={n.id: {d: round(v / q_n, 2) if q_n else 0.0 for d, v in q_app[k].items()} for k, n in enumerate(c.nodes)},
        wait_by_entry={e: round(statistics.fmean(ws), 2) for e, ws in sorted(by_entry.items())},
        main_wait=mean(main), side_wait=mean(side),
    )


# ───────────── эксперимент ─────────────

CONTROLLERS = ("fixed", "coordinated", "adaptive", "coord_adaptive")
SEEDS = tuple(range(1, 11))  # 10 повторов: прогон коридора в 4–6 раз дольше одиночного


def _node_queue(r: CorridorResult, node: str, group: str) -> float | None:
    """Средняя очередь узла на подходах магистрали (main: W, E) или поперечных улиц (cross: N, S)."""
    q = r.queue_by_approach.get(node)
    if not q:
        return None
    return round(sum(v for d, v in q.items() if (d in "WE") == (group == "main")), 3)


#: метрики парного сравнения: ключ → (как получить, меньше — лучше)
def compare_metrics(nodes: list[str]) -> dict[str, tuple]:
    m = {
        "mean_wait": (lambda r: r.mean_wait, True), "mean_time_loss": (lambda r: r.mean_time_loss, True),
        "p95_travel_time": (lambda r: r.p95_travel_time, True), "through_time_eb": (lambda r: r.through_time_eb, True),
        "through_time_wb": (lambda r: r.through_time_wb, True), "main_wait": (lambda r: r.main_wait, True),
        "side_wait": (lambda r: r.side_wait, True), "mean_stops": (lambda r: r.mean_stops, True),
        "completed": (lambda r: r.completed, False), "unfinished": (lambda r: r.unfinished, True),
        "throughput_veh_h": (lambda r: r.throughput_veh_h, False),
        "spill_total_s": (lambda r: sum(r.spill_seconds.values()), True),
    }
    for n in nodes:
        m[f"queue_main_{n}"] = (lambda r, n=n: _node_queue(r, n, "main"), True)
        m[f"queue_cross_{n}"] = (lambda r, n=n: _node_queue(r, n, "cross"), True)
    return m


PAIRS = (("adaptive", "fixed"), ("coordinated", "fixed"), ("coord_adaptive", "fixed"), ("adaptive", "coordinated"),
         ("coord_adaptive", "coordinated"), ("coord_adaptive", "adaptive"))


def summarize(runs: list[CorridorResult]) -> list[dict]:
    rows = []
    for load in dict.fromkeys(r.load for r in runs):
        for ctrl in CONTROLLERS:
            rs = [r for r in runs if r.load == load and r.controller == ctrl]
            if not rs:
                continue

            def m(f):
                xs = [f(r) for r in rs if f(r) is not None]
                return [round(statistics.fmean(xs), 2), round(statistics.stdev(xs), 2) if len(xs) > 1 else 0.0] if xs else [None, None]
            rows.append({
                "load": load, "controller": ctrl, "runs": len(rs), "seeds": [r.seed for r in rs],
                **{k: m(lambda r, k=k: getattr(r, k)) for k in (
                    "mean_wait", "mean_time_loss", "p95_travel_time", "total_time_loss_veh_h", "mean_stops", "throughput_veh_h",
                    "through_time_eb", "through_time_wb", "through_stops_eb", "through_stops_wb", "completed", "unfinished", "demand_vehicles",
                    "main_wait", "side_wait")},
                "queue_by_node": {n: m(lambda r, n=n: r.queue_by_node[n]) for n in rs[0].queue_by_node},
                "queue_by_approach": {n: {d: m(lambda r, n=n, d=d: r.queue_by_approach[n][d]) for d in rs[0].queue_by_approach[n]}
                                      for n in rs[0].queue_by_approach},
                "wait_by_entry": {e: m(lambda r, e=e: r.wait_by_entry.get(e)) for e in sorted({e for r in rs for e in r.wait_by_entry})},
                "spill_seconds": {e: m(lambda r, e=e: r.spill_seconds[e]) for e in rs[0].spill_seconds},
                "max_fill": {e: m(lambda r, e=e: r.max_fill[e]) for e in rs[0].max_fill},
                "collisions": sum(r.collisions for r in rs), "teleports": sum(r.teleports for r in rs),
                "conflict_steps": sum(r.conflict_steps for r in rs), "safety_overrides": sum(r.safety_overrides for r in rs),
                "clearance_hold_s": m(lambda r: r.clearance_hold_s), "collision_details": [d for r in rs for d in r.collision_details],
                "fallbacks": sum(r.fallbacks for r in rs),
                "decision_reasons": {k: sum(r.decision_reasons.get(k, 0) for r in rs) for k in sorted({k for r in rs for k in r.decision_reasons})},
                "stats": {k: describe(get(r) for r in rs) for k, (get, _) in compare_metrics(list(rs[0].queue_by_node)).items()},
            })
    return rows


def compare(runs: list[CorridorResult]) -> list[dict]:
    """Парные сравнения способов управления по seed (одни и те же маршруты)."""
    out = []
    for load in dict.fromkeys(r.load for r in runs):
        for a, b in PAIRS:
            ra = {r.seed: r for r in runs if r.load == load and r.controller == a}
            rb = {r.seed: r for r in runs if r.load == load and r.controller == b}
            if not ra or not rb:
                continue
            nodes = list(next(iter(ra.values())).queue_by_node)
            for key, (get, lower) in compare_metrics(nodes).items():
                res = paired({s: get(r) for s, r in ra.items()}, {s: get(r) for s, r in rb.items()}, lower_is_better=lower)
                if res:
                    out.append({"load": load, "a": a, "b": b, "metric": key, "lower_is_better": lower, **res})
    return out


def _job(args: tuple) -> CorridorResult:
    """Один прогон коридора в отдельном процессе."""
    ctrl, load, seed, duration, flows, closures, teleport_s, routes, work = args
    c = load_corridor()
    return run_corridor(c, ctrl, load, seed, duration=duration, timing=Timing(), work_dir=Path(work), flows=flows,
                        closures=closures, teleport_s=teleport_s, routes_file=Path(routes))


CSV_FIELDS = ("load", "controller", "seed", "demand_vehicles", "completed", "unfinished", "mean_wait", "mean_time_loss", "p95_travel_time",
              "through_time_eb", "through_time_wb", "main_wait", "side_wait", "mean_stops", "throughput_veh_h", "collisions", "teleports",
              "conflict_steps", "safety_overrides", "fallbacks", "clearance_hold_s", "sim_end")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Коридор проспекта Чуй в SUMO: четыре способа управления")
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    ap.add_argument("--loads", nargs="*", default=list(LOADS))
    ap.add_argument("--controllers", nargs="*", default=list(CONTROLLERS))
    ap.add_argument("--duration", type=float, default=3600.0)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="параллельных прогонов SUMO")
    ap.add_argument("--no-incident", action="store_true", help="без стресс-сценария с перекрытием выезда")
    a = ap.parse_args(argv)
    c = load_corridor()
    net = build_corridor_net(c)
    timing = Timing()
    plans = corridor_plans(c, net)
    fixed = fixed_plans(c, plans, timing)
    coord = coordinated_plans(c, plans, fixed, timing)
    work = (a.out / "_work").resolve()
    work.mkdir(parents=True, exist_ok=True)
    scen = [(load, LOADS[load], a.duration, (), 300.0) for load in a.loads]
    if not a.no_incident:
        scen.append(("incident", INCIDENT["flows"], INCIDENT["duration"], tuple(INCIDENT["closures"]), INCIDENT["teleport_s"]))
    jobs, hashes = [], {}
    for load, flows, duration, closures, tp in scen:
        for seed in a.seeds:
            routes = work / f"corr_routes_{load}_{seed}.rou.xml"
            write_routes(c, flows, duration, seed, routes)
            hashes[f"{load}/{seed}"] = hashlib.sha256(routes.read_bytes()).hexdigest()
            for ctrl in a.controllers:
                jobs.append((ctrl, load, seed, duration, flows, closures, tp, str(routes), str(work)))
    t0 = time.time()
    runs: list[CorridorResult] = []
    with ProcessPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        for r in ex.map(_job, jobs):
            runs.append(r)
            print(f"{r.load:8} seed {r.seed:2} {r.controller:14} wait {r.mean_wait} s  EB {r.through_time_eb} s  WB {r.through_time_wb} s  "
                  f"side {r.side_wait} s  done {r.completed}/{r.demand_vehicles}  spill {sum(r.spill_seconds.values())}  "
                  f"collisions {r.collisions} conflicts {r.conflict_steps} teleports {r.teleports}", flush=True)
    out = subprocess.run([sumo_bin("sumo"), "--version"], capture_output=True, text=True).stdout
    result = {
        "format": "smartflow-sumo-corridor/2",
        "corridor": {"id": c.id, "title": c.title, "nodes": [{"id": n.id, "title": n.title, "x": n.x, "osm_site": n.osm_site} for n in c.nodes],
                     "spacing_m": [round(b.x - a_.x) for a_, b in zip(c.nodes, c.nodes[1:])], "assumptions": c.raw["assumptions"],
                     "source": c.raw["source"]},
        "sumo_version": out.splitlines()[0].replace("Eclipse SUMO sumo", "SUMO").strip() if out else "SUMO ?",
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "params": {"loads_veh_h": {k: LOADS[k] for k in a.loads}, "seeds": a.seeds, "controllers": a.controllers, "duration_s": a.duration,
                   "warmup_s": WARMUP, "turns_main": TURNS_MAIN, "turns_cross": TURNS_CROSS, "timing": asdict(timing),
                   "wave_speed_kmh": round(V_FREE * 3.6), "spill_zone_m": SPILL_ZONE_M,
                   "incident": None if a.no_incident else {"title": INCIDENT["title"], "flows_veh_h": INCIDENT["flows"], "duration_s": INCIDENT["duration"], "teleport_s": INCIDENT["teleport_s"],
                                                            "closures": [{"edge": e, "from_s": t0_, "to_s": t1_} for e, t0_, t1_ in INCIDENT["closures"]]},
                   "fixed": fixed, "coordinated": coord,
                   "adaptive": [{"node": c.nodes[k].id, **asdict(adaptive_limits(f["greens"]))} for k, f in enumerate(fixed)],
                   "plans": [{"node": c.nodes[k].id, "name": name, "phases": [p.name for p in plan.phases]} for k, (name, plan) in enumerate(plans)],
                   "routes_sha256": hashes},
        "summary": summarize(runs),
        "comparisons": compare(runs),
        "runs": [asdict(r) | {"plans": None} for r in runs],
        "elapsed_s": round(time.time() - t0, 1),
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "corridor-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    with (a.out / "corridor-runs.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_FIELDS)
        for r in runs:
            d = asdict(r)
            w.writerow([d[k] for k in CSV_FIELDS])
    print(f"готово за {result['elapsed_s']} с → {a.out / 'corridor-results.json'}")


if __name__ == "__main__":
    main()
