"""Проверки с настоящим SUMO: геометрия, повороты, фазы, безопасность прогона, метрики, воспроизводимость, формат записи.

Пропускаются, если SUMO не установлен (pip install eclipse-sumo traci sumolib).
"""
import itertools
import json
import math
import os
import shutil
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from smartflow_sumo.build import (BUILD_DIR, SCENARIO_DIR as SC_DIR, Demand, allowed_turns, build_net, load_scenario, make_plan, read_links_and_foes,
                                  sumo_bin, target)
from smartflow_sumo.control import Movement, Timing
from smartflow_sumo.experiment import LOADS, TURNS, demand_for, fixed_plan, lane_flows
from smartflow_sumo.run import Faults, SimulatorConnectionError, classify, run
from smartflow_sumo.trace import TraceRecorder, validate_trace

try:
    sumo_bin("sumo")
    sumo_bin("netconvert")
    import traci  # noqa: F401
    HAVE_SUMO = True
except (FileNotFoundError, ImportError):
    HAVE_SUMO = False
    if os.environ.get("SMARTFLOW_REQUIRE_SUMO"):
        raise  # в CI SUMO обязателен: тесты не должны тихо пропускаться

SC = load_scenario("chui-manas")


@unittest.skipUnless(HAVE_SUMO, "SUMO не установлен")
class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.net = build_net(SC, cls.tmp)
        cls.root = ET.parse(cls.net).getroot()

    def edge(self, eid):
        return self.root.find(f"edge[@id='{eid}']")

    def test_four_arms_with_lanes_from_scenario(self):
        for k, arm in SC.arms.items():
            self.assertEqual(len(self.edge(f"{k}_in").findall("lane")), len(arm.lanes_in), k)
            self.assertEqual(len(self.edge(f"{k}_out").findall("lane")), arm.lanes_out, k)

    def test_arm_bearings_match_osm(self):
        """Азимут входной полосы (от её начала к стоп-линии, обратный) совпадает с азимутом улицы в OSM ±2°."""
        for k, arm in SC.arms.items():
            pts = [tuple(map(float, p.split(","))) for p in self.edge(f"{k}_in").find("lane").get("shape").split()]
            (x0, y0), (x1, y1) = pts[0], pts[-1]
            b = (math.degrees(math.atan2(x0 - x1, y0 - y1)) + 360) % 360
            d = min(abs(b - arm.bearing), 360 - abs(b - arm.bearing))
            self.assertLess(d, 2.0, f"{k}: {b:.1f}° против {arm.bearing}°")

    def test_allowed_turns_exactly_as_lane_marking(self):
        conns = [c for c in self.root.findall("connection") if c.get("tl") == "C"]
        got = {(c.get("from"), int(c.get("fromLane")), c.get("to")) for c in conns}
        want = set()
        for k, arm in SC.arms.items():
            n = len(arm.lanes_in)
            for pos, use in enumerate(arm.lanes_in):
                for t in use:
                    want.add((f"{k}_in", n - 1 - pos, f"{target(k, t)}_out"))
        self.assertEqual(got, want)
        # разворотов нет
        self.assertFalse(any(c.get("from")[0] == c.get("to")[0] for c in conns))

    def test_foe_matrix_sane(self):
        links, foes = read_links_and_foes(self.net)
        idx = {str(l.movement): l.index for l in links}
        f = lambda a, b: (min(idx[a], idx[b]), max(idx[a], idx[b])) in foes  # noqa: E731
        self.assertTrue(f("NT", "ET"), "пересекающиеся прямые — конфликт")
        self.assertTrue(f("EL", "WT"), "левый и встречный прямой — конфликт")
        self.assertFalse(f("NT", "ST"), "встречные прямые — не конфликт")
        self.assertFalse(f("ET", "WT"))

    def test_plan_has_no_conflicting_greens_and_serves_all(self):
        name, plan = make_plan(self.net, SC)
        # общие полосы «налево + прямо» без конфликтующих зелёных обслуживаются только раздельными фазами подходов
        self.assertEqual([p.name for p in plan.phases], ["подход с севера", "подход с юга", "подход с востока", "подход с запада"])
        for k in range(plan.n):
            self.assertEqual(plan.conflicting_greens(plan.state(k, "green")), [], plan.phases[k].name)
        served = set().union(*plan.green_links)
        self.assertEqual(served, set(range(len(plan.links))))
        moves = {str(l.movement) for l in plan.links}
        for a in "NESW":
            for t in allowed_turns(SC, a):
                self.assertIn(f"{a}{t}", moves)

    def test_osm_turn_restrictions_respected(self):
        """Все запреты поворотов OSM у перекрёстка учтены в сценарии, запрещённых соединений в сети нет."""
        osm = json.loads((SC_DIR / "osm" / "chui-manas.restrictions.json").read_text(encoding="utf-8"))
        mapped = {r["id"]: r for r in SC.raw["osm_restrictions"]["relations"]}
        for rel in osm["restrictions_at_intersection"]:
            with self.subTest(relation=rel["id"]):
                self.assertIn(rel["id"], mapped, "запрет из OSM не разобран в сценарии")
                m = mapped[rel["id"]]
                self.assertEqual(m["restriction"], rel["tags"]["restriction"])
                self.assertEqual([m["from_way"]], [x["id"] for x in rel["from"]])
                self.assertEqual([m["to_way"]], [x["id"] for x in rel["to"]])
                self.assertEqual([m["via_node"]], [x["id"] for x in rel["via"]])
        conns = {(c.get("from")[0], c.get("to")[0]) for c in self.root.findall("connection") if c.get("tl") == "C"}
        for m in mapped.values():
            if m["movement"] and m["restriction"].startswith("no_"):
                a, t = m["movement"]
                self.assertNotIn((a, target(a, t)), conns, f"{m['id']}: {m['movement']} запрещён в OSM")

    def test_lane_flows_conserve_demand(self):
        d = demand_for("medium")
        lf = lane_flows(SC, d)
        for a in "NESW":
            self.assertAlmostEqual(sum(v for k, v in lf.items() if k.startswith(a)), d.flows[a], places=6)


@unittest.skipUnless(HAVE_SUMO, "SUMO не установлен")
class RunTests(unittest.TestCase):
    """Короткие прогоны (15 мин спроса) обоих контроллеров при средней нагрузке."""

    @classmethod
    def setUpClass(cls):
        if not (BUILD_DIR / SC.id / "net.net.xml").exists():
            build_net(SC)
        cls.fixed = fixed_plan(SC, Timing())
        cls.work = Path(tempfile.mkdtemp())
        cls.results = {}
        cls.trace = {}
        for ctrl in ("fixed", "adaptive"):
            tr = TraceRecorder((300.0, 420.0))
            cls.results[ctrl] = run(SC, ctrl, "medium", demand_for("medium", 900), 7, fixed_greens=cls.fixed["greens_s"],
                                    drain=900, trace=tr, keep_states=True, work_dir=cls.work)
            cls.trace[ctrl] = tr.data

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def test_safety(self):
        for ctrl, r in self.results.items():
            with self.subTest(ctrl):
                self.assertEqual(r.collisions, 0)
                self.assertEqual(r.conflict_steps, 0, "в SUMO горели зелёные конфликтующим связям")
                self.assertEqual(r.teleports, 0)
                self.assertEqual(r.safety_overrides, 0, "в SUMO горело не то, что задано")
                self.assertIsNone(r.fallback_at, "контроллер не должен уходить в резерв в обычном прогоне")

    def test_decision_log_and_extended_metrics(self):
        for ctrl, r in self.results.items():
            with self.subTest(ctrl):
                self.assertEqual(len(r.decisions), r.switches, "каждая смена фазы записана")
                self.assertTrue(all(d["reason"] for d in r.decisions))
                self.assertGreater(r.p95_travel_time, 0)
                self.assertGreaterEqual(r.p95_travel_time, r.mean_wait)
                self.assertGreater(r.throughput_veh_h, 0)
                self.assertGreaterEqual(r.mean_stops, 0)
                self.assertEqual(set(r.wait_by_approach), set("NESW"))
                for a in "NESW":
                    self.assertGreaterEqual(r.max_wait_by_approach[a], r.wait_by_approach[a])
        self.assertIn("фиксированный план", self.results["fixed"].decision_reasons)
        self.assertTrue(set(self.results["adaptive"].decision_reasons) & {"разрыв потока", "максимум зелёного фазы", "защита от голодания"})

    def test_signal_sequence_in_sumo(self):
        """Фактическая история сигнала в SUMO: зелёный ≥ 8 с, затем жёлтый 3 с, затем «все красные» 2 с."""
        for ctrl, r in self.results.items():
            with self.subTest(ctrl):
                st = r.states
                for (t0, s0), (t1, s1) in zip(st, st[1:]):
                    k0, k1 = classify(s0), classify(s1)
                    self.assertNotEqual((k0, k1), ("green", "green"), f"зелёный сменился зелёным в t={t1}")
                    if k0 == "green":
                        self.assertEqual(k1, "yellow")
                        self.assertGreaterEqual(t1 - t0, 8 - 1e-6)
                    if k0 == "yellow":
                        self.assertEqual(k1, "allred")
                        self.assertAlmostEqual(t1 - t0, 3, places=6)
                    if k0 == "allred":
                        self.assertEqual(k1, "green")
                        self.assertAlmostEqual(t1 - t0, 2, places=6)

    def test_fixed_cycle_follows_plan(self):
        st = self.results["fixed"].states
        greens = [round(t1 - t0) for (t0, s0), (t1, _) in zip(st, st[1:]) if classify(s0) == "green"]
        plan_greens = [int(g) for g in self.fixed["greens_s"]]
        self.assertEqual(greens[: len(plan_greens) * 2], plan_greens * 2)

    def test_metrics_present_and_all_trips_completed(self):
        for ctrl, r in self.results.items():
            with self.subTest(ctrl):
                self.assertEqual(r.unfinished, 0)
                self.assertEqual(r.completed, r.demand_vehicles)
                self.assertGreater(r.measured_trips, 100)
                self.assertGreater(r.mean_wait, 0)
                self.assertGreater(r.mean_queue, 0)
                self.assertEqual(set(r.queue_by_approach), set("NESW"))

    def test_same_routes_for_both_controllers(self):
        self.assertEqual(self.results["fixed"].demand_vehicles, self.results["adaptive"].demand_vehicles)
        a = (self.work / "routes_medium_7.rou.xml").read_text()
        self.assertIn('id="car"', a)

    def test_reproducible(self):
        again = run(SC, "adaptive", "medium", demand_for("medium", 900), 7, fixed_greens=self.fixed["greens_s"], drain=900,
                    work_dir=Path(tempfile.mkdtemp()))
        r = self.results["adaptive"]
        for f in ("mean_wait", "mean_queue", "completed", "switches", "max_queue_approach"):
            self.assertEqual(getattr(again, f), getattr(r, f), f)

    def test_trace_format(self):
        for ctrl, d in self.trace.items():
            with self.subTest(ctrl):
                self.assertEqual(validate_trace(d), [])
                self.assertEqual(len(d["frames"]), 121)
                f = d["frames"][10]
                self.assertEqual(len(f["signal"]), len(d["geometry"]["links"]))
                self.assertGreater(len(f["v"]), 0)
                # машины в кадре лежат в пределах сети
                x0, y0, x1, y1 = d["geometry"]["bounds"]
                for i in range(0, len(f["v"]), 5):
                    self.assertTrue(x0 - 5 <= f["v"][i + 1] <= x1 + 5 and y0 - 5 <= f["v"][i + 2] <= y1 + 5)
        broken = json.loads(json.dumps(self.trace["fixed"]))
        broken["frames"][3]["signal"] = "G"
        self.assertTrue(validate_trace(broken))


@unittest.skipUnless(HAVE_SUMO, "SUMO не установлен")
class EdgeCaseTests(unittest.TestCase):
    """Крайние случаи: нет машин, перегрузка одного направления, закрытая полоса, сбои датчиков, контроллера,
    чужая команда светофору, авария симулятора."""

    @classmethod
    def setUpClass(cls):
        if not (BUILD_DIR / SC.id / "net.net.xml").exists():
            build_net(SC)
        cls.fixed = fixed_plan(SC, Timing())
        cls.work = Path(tempfile.mkdtemp())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def go(self, ctrl, flows, duration=600.0, faults=None, seed=3, drain=900.0):
        d = Demand(flows=dict(flows), turns=dict(TURNS), duration=duration)
        return run(SC, ctrl, "edge", d, seed, fixed_greens=self.fixed["greens_s"], drain=drain, keep_states=True,
                   work_dir=self.work, faults=faults)

    def assertSafe(self, r):
        self.assertEqual(r.collisions, 0)
        self.assertEqual(r.teleports, 0)
        for (t0, s0), (t1, s1) in zip(r.states, r.states[1:]):
            if classify(s0) == "green" and classify(s1) == "green":
                self.fail(f"зелёный сменился зелёным в t={t1}")

    def test_no_vehicles(self):
        for ctrl in ("fixed", "adaptive"):
            with self.subTest(ctrl):
                r = self.go(ctrl, {a: 0 for a in "NESW"}, duration=400, drain=0)
                self.assertSafe(r)
                self.assertEqual(r.demand_vehicles, 0)
                self.assertEqual(r.completed, 0)
                for k in ("mean_wait", "p95_travel_time", "mean_stops", "total_wait_veh_h"):
                    self.assertIsNone(getattr(r, k), f"{k}: без машин метрика не выдумывается")
                self.assertEqual(r.throughput_veh_h, 0.0)
                if ctrl == "adaptive":
                    self.assertTrue(r.decisions and all("жёсткий максимум" in d["reason"] for d in r.decisions),
                                    "без спроса адаптивный не переключает, фазы меняет только страж по максимуму")

    def test_one_direction_overload(self):
        flows = {"E": 1000, "W": 0, "N": 80, "S": 0}
        res = {c: self.go(c, flows) for c in ("fixed", "adaptive")}
        for c, r in res.items():
            with self.subTest(c):
                self.assertSafe(r)
                self.assertEqual(r.unfinished, 0)
        a = res["adaptive"]
        self.assertLess(a.wait_by_approach["E"], res["fixed"].wait_by_approach["E"], "перегруженному подходу адаптивный даёт больше зелёного")
        self.assertLessEqual(a.max_wait_by_approach["N"], 120 + 3 * (5 + 8) + 10, "малый поток не ждёт бесконечно (защита от голодания)")

    def test_lane_closure(self):
        # средняя полоса подхода с запада («прямо») закрыта с начала: прямые едут по полосе «прямо + направо»
        r = self.go("adaptive", LOADS["low"], faults=Faults(closed_lanes={"W_in_1": 0.0}))
        self.assertSafe(r)
        self.assertEqual(r.unfinished, 0)
        self.assertEqual(r.conflict_steps, 0)

    def test_sensor_failure_falls_back_to_fixed_plan(self):
        r = self.go("adaptive", LOADS["medium"], faults=Faults(sensor_fail_at=200.0, sensor_approach="N"))
        self.assertSafe(r)
        self.assertIsNotNone(r.fallback_at)
        self.assertTrue(200 <= r.fallback_at <= 200 + 130, r.fallback_at)
        self.assertIn("SensorError", r.fallback_reason)
        after = [d for d in r.decisions if d["time"] > r.fallback_at]
        self.assertTrue(after and all("резервный план" in d["reason"] or "страж" in d["controller"] for d in after))
        self.assertEqual(r.unfinished, 0)

    def test_controller_exception_falls_back(self):
        r = self.go("adaptive", LOADS["medium"], faults=Faults(controller_fail_at=150.0))
        self.assertSafe(r)
        self.assertTrue(150 <= r.fallback_at <= 150 + 130, r.fallback_at)
        self.assertIn("RuntimeError", r.fallback_reason)
        self.assertEqual(r.conflict_steps, 0)

    def test_foreign_signal_state_forces_all_red(self):
        r = self.go("fixed", LOADS["low"], faults=Faults(foreign_state_at=100.0))
        self.assertEqual(r.safety_overrides, 1)
        self.assertEqual(r.conflict_steps, 1, "чужие конфликтующие зелёные продержались ровно один шаг")
        self.assertEqual(r.collisions, 0)
        i = next(k for k, (t, s) in enumerate(r.states) if set(s) == {"G"})
        self.assertEqual(classify(r.states[i + 1][1]), "allred", "сразу после обнаружения — «все красные»")
        self.assertTrue(any("вместо заданного" in d["reason"] for d in r.decisions))

    def test_simulator_crash_raises_clear_error(self):
        t0 = time.time()
        with self.assertRaises(SimulatorConnectionError) as cm:
            self.go("adaptive", LOADS["low"], faults=Faults(kill_at=60.0))
        self.assertLess(time.time() - t0, 60, "прогон не зависает")
        self.assertIn("связь с SUMO потеряна", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
