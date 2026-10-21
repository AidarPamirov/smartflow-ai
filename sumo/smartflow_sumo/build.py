"""Построение сценария SUMO из описания перекрёстка: сеть, связи светофора, план фаз, спрос.

Сеть схематизирована: подходы — прямые отрезки по азимутам улиц, число полос и разрешённые
манёвры — из описания (sumo/scenario/*.json, где у каждого параметра указан источник).
Точная геометрия бордюров, островков и разметки реального перекрёстка НЕ воспроизводится.
"""
from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .control import APPROACHES, Link, Movement, Phase, SignalPlan, UnsafePlanError

ROOT = Path(__file__).resolve().parents[1]
SCENARIO_DIR = ROOT / "scenario"
BUILD_DIR = ROOT / "build"
TLS_ID = "C"


# ───────────── описание перекрёстка ─────────────

@dataclass(frozen=True)
class Arm:
    key: str  # N / E / S / W — сторона света, с которой подходит улица
    street: str
    bearing: float  # азимут от центра вдоль улицы, градусы
    lanes_in: tuple[str, ...]  # разрешённые манёвры по полосам въезда, слева направо: "L", "T", "TR", …
    lanes_out: int
    speed_kmh: float


@dataclass(frozen=True)
class Scenario:
    id: str
    title: str
    center_lat: float
    center_lon: float
    approach_length: float
    lane_width: float
    arms: dict[str, Arm]
    raw: dict


def load_scenario(name: str) -> Scenario:
    raw = json.loads((SCENARIO_DIR / f"{name}.json").read_text(encoding="utf-8"))
    arms = {}
    for key in APPROACHES:
        a = raw["arms"][key]
        lanes = tuple(a["lanes_in"]["value"])
        if not lanes or any(not set(x) <= {"L", "T", "R"} or not x for x in lanes):
            raise ValueError(f"{key}: неверное описание полос {lanes}")
        arms[key] = Arm(key, a["street"], float(a["bearing_deg"]["value"]), lanes, int(a["lanes_out"]["value"]),
                        float(a["speed_kmh"]["value"]))
    return Scenario(raw["id"], raw["title"], raw["center"]["lat"], raw["center"]["lon"], float(raw["approach_length_m"]),
                    float(raw["lane_width_m"]), arms, raw)


def target(approach: str, turn: str) -> str:
    """Куда уезжает машина: правостороннее движение, стороны по часовой стрелке N, E, S, W."""
    i = APPROACHES.index(approach)
    return {"T": APPROACHES[(i + 2) % 4], "R": APPROACHES[(i + 3) % 4], "L": APPROACHES[(i + 1) % 4]}[turn]


def turn_of(approach: str, exit_: str) -> str:
    for t in ("L", "T", "R"):
        if target(approach, t) == exit_:
            return t
    raise ValueError(f"разворот {approach}→{exit_} не моделируется")


# ───────────── сеть ─────────────

def _xy(bearing: float, dist: float) -> tuple[float, float]:
    b = math.radians(bearing)
    return round(dist * math.sin(b), 2), round(dist * math.cos(b), 2)


def write_plain_xml(sc: Scenario, out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    nod = ET.Element("nodes")
    ET.SubElement(nod, "node", id=TLS_ID, x="0", y="0", type="traffic_light", tl=TLS_ID)
    for k, a in sc.arms.items():
        x, y = _xy(a.bearing, sc.approach_length)
        ET.SubElement(nod, "node", id=f"{k}_end", x=str(x), y=str(y), type="priority")
    edg = ET.Element("edges")
    for k, a in sc.arms.items():
        common = dict(speed=f"{a.speed_kmh / 3.6:.2f}", width=str(sc.lane_width), priority="2")
        ET.SubElement(edg, "edge", id=f"{k}_in", **{"from": f"{k}_end", "to": TLS_ID}, numLanes=str(len(a.lanes_in)), **common)
        ET.SubElement(edg, "edge", id=f"{k}_out", **{"from": TLS_ID, "to": f"{k}_end"}, numLanes=str(a.lanes_out), **common)
    con = ET.Element("connections")
    for k, a in sc.arms.items():
        n = len(a.lanes_in)
        # полосы описаны слева направо; в SUMO полоса 0 — крайняя правая
        by_turn: dict[str, list[int]] = {"L": [], "T": [], "R": []}
        for pos, use in enumerate(a.lanes_in):
            for t in use:
                by_turn[t].append(n - 1 - pos)
        for t, lanes in by_turn.items():
            if not lanes:
                continue
            out_n = sc.arms[target(k, t)].lanes_out
            lanes_sorted = sorted(lanes)  # справа налево
            for i, from_lane in enumerate(lanes_sorted):
                if t == "R":
                    to_lane = min(i, out_n - 1)
                elif t == "L":
                    to_lane = max(out_n - len(lanes_sorted) + i, 0)
                else:
                    to_lane = min(i, out_n - 1)
                ET.SubElement(con, "connection", **{"from": f"{k}_in", "to": f"{target(k, t)}_out"},
                              fromLane=str(from_lane), toLane=str(to_lane))
    files = {}
    for name, root in (("nod", nod), ("edg", edg), ("con", con)):
        ET.indent(root)
        p = out / f"plain.{name}.xml"
        ET.ElementTree(root).write(p, encoding="utf-8", xml_declaration=True)
        files[name] = p
    return files


def sumo_bin(name: str) -> str:
    """Путь к программе SUMO. Сначала — сам исполняемый файл из пакета eclipse-sumo (без промежуточной обёртки
    из pip, чтобы процесс TraCI был настоящим процессом SUMO), затем — из PATH."""
    try:
        import sumo  # eclipse-sumo из pip
        p = Path(sumo.SUMO_HOME) / "bin" / name
        if p.exists():
            return str(p)
    except ImportError:
        pass
    path = shutil.which(name)
    if path:
        return path
    raise FileNotFoundError(f"{name} не найден: установите SUMO (pip install eclipse-sumo)")


def build_net(sc: Scenario, out: Path | None = None) -> Path:
    out = out or BUILD_DIR / sc.id
    files = write_plain_xml(sc, out)
    net = out / "net.net.xml"
    cmd = [sumo_bin("netconvert"), "--node-files", str(files["nod"]), "--edge-files", str(files["edg"]),
           "--connection-files", str(files["con"]), "--output-file", str(net),
           "--no-turnarounds", "true", "--junctions.corner-detail", "8", "--tls.default-type", "static",
           "--offset.disable-normalization", "true", "--no-warnings", "true"]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return net


# ───────────── связи светофора и конфликты из сети SUMO ─────────────

def read_links_and_foes(net_path: Path, tls: str = TLS_ID, in_dir=None, out_dir=None) -> tuple[list[Link], set[tuple[int, int]]]:
    """Связи светофора (индекс, входная полоса, манёвр) и пары конфликтующих связей по матрице SUMO.

    in_dir / out_dir — сторона света входного и выходного ребра для этого узла; по умолчанию — первая буква id
    ребра (схема одиночного перекрёстка: N_in, E_out, …). Для коридора их задаёт построитель сети.
    """
    in_dir = in_dir or (lambda e: e.split("_")[0])
    out_dir = out_dir or (lambda e: e.split("_")[0])
    root = ET.parse(net_path).getroot()
    links: dict[int, Link] = {}
    junction_index: dict[int, int] = {}
    # индексы связей узла (request index) идут по порядку соединений с входных полос узла
    incoming = [l for l in root.find(f"junction[@id='{tls}']").get("incLanes").split()]
    jidx = 0
    conns = [c for c in root.findall("connection") if c.get("tl") == tls]
    by_lane: dict[str, list[ET.Element]] = {}
    for c in conns:
        by_lane.setdefault(f"{c.get('from')}_{c.get('fromLane')}", []).append(c)
    for lane in incoming:
        for c in by_lane.get(lane, []):
            tl = int(c.get("linkIndex"))
            fr, to = c.get("from"), c.get("to")
            app, ex = in_dir(fr), out_dir(to)
            links[tl] = Link(tl, lane, Movement(app, turn_of(app, ex)))
            junction_index[tl] = jidx
            jidx += 1
    req = {int(r.get("index")): r.get("foes") for r in root.find(f"junction[@id='{tls}']").findall("request")}
    inv = {j: t for t, j in junction_index.items()}
    foes = set()
    for i, bits in req.items():
        for pos, ch in enumerate(reversed(bits)):  # самый правый символ — связь 0
            if ch == "1":
                a, b = inv[i], inv[pos]
                foes.add((min(a, b), max(a, b)))
    return [links[i] for i in sorted(links)], foes


def movements_of(links: list[Link]) -> set[Movement]:
    return {l.movement for l in links}


def candidate_plans(moves: set[Movement], sc: Scenario | None = None) -> list[tuple[str, list[Phase]]]:
    """Варианты плана фаз по разметке подходов.

    Для каждой оси (С–Ю, В–З): если у обоих подходов есть отдельная левая полоса — две фазы
    («прямо + направо» обеих сторон, затем «налево» обеих сторон, защищённый левый поворот);
    иначе — по фазе на каждый подход (все манёвры подхода сразу). Запасной вариант — все подходы раздельно.
    Каждый вариант затем проверяется по матрице конфликтов SUMO.
    """
    def ph(name: str, pairs: list[tuple[str, str]]) -> Phase:
        return Phase(name, frozenset(m for m in (Movement(a, t) for a, t in pairs) if m in moves))

    def has_dedicated_left(a: str) -> bool:
        return sc is not None and "L" in sc.arms[a].lanes_in

    label = {"N": "с севера", "S": "с юга", "E": "с востока", "W": "с запада"}
    axes = [("С–Ю", ("N", "S")), ("В–З", ("E", "W"))]
    mixed: list[Phase] = []
    kinds = []
    for axis, (a, b) in axes:
        if has_dedicated_left(a) and has_dedicated_left(b):
            mixed.append(ph(f"{axis}: прямо и направо", [(a, "T"), (a, "R"), (b, "T"), (b, "R")]))
            mixed.append(ph(f"{axis}: налево", [(a, "L"), (b, "L")]))
            kinds.append(f"{axis} защищённый левый")
        else:
            mixed.append(ph(f"подход {label[a]}", [(a, t) for t in ("L", "T", "R")]))
            mixed.append(ph(f"подход {label[b]}", [(b, t) for t in ("L", "T", "R")]))
            kinds.append(f"{axis} по подходам")
    split = [ph(f"подход {label[a]}", [(a, t) for t in ("L", "T", "R")]) for a in ("N", "S", "E", "W")]
    return [(", ".join(kinds), [p for p in mixed if p.movements]), ("все подходы раздельно", [p for p in split if p.movements])]


def make_plan(net_path: Path, sc: Scenario | None = None) -> tuple[str, SignalPlan]:
    links, foes = read_links_and_foes(net_path)
    errors = []
    for name, phases in candidate_plans(movements_of(links), sc):
        try:
            return name, SignalPlan(links, phases, foes)
        except UnsafePlanError as e:
            errors.append(f"{name}: {e}")
    raise UnsafePlanError("ни один план фаз не прошёл проверку: " + "; ".join(errors))


# ───────────── спрос ─────────────

@dataclass(frozen=True)
class Demand:
    #: интенсивность по подходам, авт/ч
    flows: dict[str, float]
    #: доли манёвров (L/T/R), нормируются по разрешённым манёврам подхода
    turns: dict[str, float]
    duration: float


def allowed_turns(sc: Scenario, approach: str) -> list[str]:
    return sorted({t for use in sc.arms[approach].lanes_in for t in use}, key="LTR".index)


def write_routes(sc: Scenario, demand: Demand, seed: int, path: Path) -> int:
    """Пуассоновские прибытия; одинаковый seed → одинаковый файл для любого контроллера."""
    rng = random.Random(seed)
    vehicles = []
    for a in APPROACHES:
        q = demand.flows.get(a, 0.0)
        if q <= 0:
            continue
        turns = allowed_turns(sc, a)
        w = [demand.turns.get(t, 0.0) for t in turns]
        s = sum(w)
        t = rng.expovariate(q / 3600)
        while t < demand.duration:
            u, acc, turn = rng.random() * s, 0.0, turns[-1]
            for tt, ww in zip(turns, w):
                acc += ww
                if u < acc:
                    turn = tt
                    break
            vehicles.append((round(t, 2), a, turn))
            t += rng.expovariate(q / 3600)
    vehicles.sort()
    root = ET.Element("routes")
    ET.SubElement(root, "vType", id="car", vClass="passenger", length="4.5", minGap="2.5", accel="2.6", decel="4.5",
                  sigma="0.5", maxSpeed="16.7", tau="1.0")
    for i, (t, a, turn) in enumerate(vehicles):
        v = ET.SubElement(root, "vehicle", id=f"{a}{turn}_{i}", type="car", depart=f"{t:.2f}", departLane="best",
                          departSpeed="max", departPos="base")
        ET.SubElement(v, "route", edges=f"{a}_in {target(a, turn)}_out")
    ET.indent(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return len(vehicles)


def webster_greens(plan: SignalPlan, flows_per_lane: dict[str, float], sat_flow: float = 1800.0,
                   lost_per_phase: float = 5.0, cycle_bounds: tuple[float, float] = (60.0, 120.0),
                   min_green: float = 8.0) -> tuple[float, list[float]]:
    """Расчёт фиксированного цикла по Уэбстеру: C₀ = (1,5·L + 5) / (1 − Y), зелёный ∝ y фазы.

    y фазы — максимальная загрузка (поток / поток насыщения) среди её входных полос.
    """
    ys = [max((flows_per_lane.get(l, 0.0) / sat_flow for l in lanes), default=0.0) for lanes in plan.phase_lanes]
    Y = min(sum(ys), 0.9)
    L = lost_per_phase * plan.n
    c0 = (1.5 * L + 5) / (1 - Y)
    cycle = max(cycle_bounds[0], min(cycle_bounds[1], c0))
    eff = cycle - L
    total = sum(ys) or 1.0
    greens = [max(min_green, round(eff * y / total)) for y in ys]  # целые секунды: шаг модели 1 с
    return cycle, [float(g) for g in greens]
