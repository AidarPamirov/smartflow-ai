"""Коридор из четырёх связанных перекрёстков: сеть, спрос, согласованный план, безопасность прогонов."""
import os
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from smartflow_sumo.build import BUILD_DIR, sumo_bin, target
from smartflow_sumo.control import FixedTimeController, Observation, SignalSupervisor, Timing, tick
from smartflow_sumo.corridor import (CONTROLLERS, INCIDENT, LOADS, V_FREE, allowed, build_corridor_net, coordinated_plans, corridor_plans, dir_maps,
                                     edge_in, edge_out, expected_flows, fixed_plans, load_corridor, place_in_cycle, run_corridor,
                                     write_routes)

try:
    sumo_bin("sumo")
    sumo_bin("netconvert")
    import traci  # noqa: F401
    HAVE_SUMO = True
except (FileNotFoundError, ImportError):
    HAVE_SUMO = False
    if os.environ.get("SMARTFLOW_REQUIRE_SUMO"):
        raise

C = load_corridor()


class DemandTests(unittest.TestCase):
    """Без SUMO: сохранение потока и воспроизводимость маршрутов."""

    def test_flow_conservation(self):
        flows = LOADS["medium"]
        ex = expected_flows(C, flows)
        # всё, что въехало, где-то выехало: сумма выездов на края сети = сумма въездов
        out = 0.0
        for (k, d, t), f in ex.items():
            e = target(d, t)
            if e in "NS" or (e == "E" and k == len(C.nodes) - 1) or (e == "W" and k == 0):
                out += f
        self.assertAlmostEqual(out, sum(flows.values()), places=6)

    def test_routes_reproducible_and_follow_allowed_turns(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            a = write_routes(C, LOADS["low"], 900, 7, tmp / "a.xml")
            b = write_routes(C, LOADS["low"], 900, 7, tmp / "b.xml")
            self.assertEqual(a, b)
            self.assertEqual((tmp / "a.xml").read_text(), (tmp / "b.xml").read_text())
            c = write_routes(C, LOADS["low"], 900, 8, tmp / "c.xml")
            self.assertNotEqual(a, c)
            ins = {edge_in(C, k, d): (k, d) for k, n in enumerate(C.nodes) for d in n.lanes_in}
            for v in ET.parse(tmp / "a.xml").getroot().findall("vehicle"):
                edges = v.find("route").get("edges").split()
                for e1, e2 in zip(edges, edges[1:]):
                    k, d = ins[e1]
                    turn = next(t for t in "LTR" if edge_out(C, k, target(d, t)) == e2)
                    self.assertIn(turn, allowed(C.nodes[k], d), f"{v.get('id')}: {e1}→{e2}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_SUMO, "SUMO не установлен")
class CorridorNetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.net = build_corridor_net(C, Path(tempfile.mkdtemp()))
        cls.root = ET.parse(cls.net).getroot()
        cls.plans = corridor_plans(C, cls.net)

    def test_four_signals_and_lanes(self):
        tls = {j.get("id") for j in self.root.findall("junction") if j.get("type") == "traffic_light"}
        self.assertEqual(tls, {n.id for n in C.nodes})
        for (a, b), lanes in C.seg_lanes.items():
            e = self.root.find(f"edge[@id='{a}_to_{b}']")
            if e is not None:
                self.assertEqual(len(e.findall("lane")), lanes, f"{a}→{b}")

    def test_connections_exactly_as_lane_marking(self):
        for k, n in enumerate(C.nodes):
            ins, outs = dir_maps(C, k)
            got = {(ins[c.get("from")], int(c.get("fromLane")), outs[c.get("to")]) for c in self.root.findall("connection") if c.get("tl") == n.id}
            want = set()
            for d, uses in n.lanes_in.items():
                for pos, use in enumerate(uses):
                    for t in use:
                        want.add((d, len(uses) - 1 - pos, target(d, t)))
            self.assertEqual(got, want, n.id)

    def test_plans_safe_and_complete(self):
        for (name, plan), n in zip(self.plans, C.nodes):
            for k in range(plan.n):
                self.assertEqual(plan.conflicting_greens(plan.state(k, "green")), [], f"{n.id}: {plan.phases[k].name}")
            self.assertEqual(set().union(*plan.green_links), set(range(len(plan.links))))
        self.assertEqual(self.plans[0][1].n, 3, "Т-образный перекрёсток Интергельпо — три фазы")

    def test_green_wave_offsets(self):
        """Согласованный план: зелёный для прямого на восток начинается со сдвигом = время хода «волны» от первого узла."""
        timing = Timing()
        fixed = fixed_plans(C, self.plans, timing)
        coord = coordinated_plans(C, self.plans, fixed, timing)
        cyc = coord[0]["cycle"]
        self.assertTrue(all(c["cycle"] == cyc for c in coord), "общий цикл")
        starts = []
        for k, ((_, plan), cp) in enumerate(zip(self.plans, coord)):
            sup = SignalSupervisor(plan, timing)
            ph, st, el = place_in_cycle(cp["greens"], timing, (-cp["offset"]) % cyc)
            sup.phase, sup.next_phase, sup.stage, sup.elapsed = ph, (ph + 1) % plan.n if st != "green" else ph, st, el
            ctrl = FixedTimeController(cp["greens"])
            t, first = 0, None
            prev = (sup.stage, sup.phase)
            while first is None and t < 3 * cyc:
                tick(sup, ctrl, Observation(float(t)), 1.0)
                t += 1
                if sup.stage == "green" and sup.phase == cp["east_phase"] and prev != ("green", cp["east_phase"]) and t > cyc:
                    first = t
                prev = (sup.stage, sup.phase)
            starts.append(first)
        for k in range(1, len(C.nodes)):
            want = (C.nodes[k].x - C.nodes[0].x) / V_FREE
            got = (starts[k] - starts[0]) % cyc
            self.assertLessEqual(min(abs(got - want % cyc), cyc - abs(got - want % cyc)), 1.5, f"{C.nodes[k].id}: {got} против {want:.1f}")


@unittest.skipUnless(HAVE_SUMO, "SUMO не установлен")
class CorridorRunTests(unittest.TestCase):
    """Короткие прогоны (10 мин спроса) трёх способов управления."""

    @classmethod
    def setUpClass(cls):
        if not (BUILD_DIR / C.id / "net.net.xml").exists():
            build_corridor_net(C)
        cls.work = Path(tempfile.mkdtemp())
        cls.res = {ctrl: run_corridor(C, ctrl, "medium", 5, duration=600, drain=900, work_dir=cls.work) for ctrl in CONTROLLERS}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def test_safety_all_nodes(self):
        for ctrl, r in self.res.items():
            with self.subTest(ctrl):
                self.assertEqual(r.collisions, 0)
                self.assertEqual(r.conflict_steps, 0)
                self.assertEqual(r.teleports, 0)
                self.assertEqual(r.safety_overrides, 0)
                self.assertEqual(r.fallbacks, 0)
                self.assertEqual(r.unfinished, 0)

    def test_same_demand_and_metrics(self):
        n = {r.demand_vehicles for r in self.res.values()}
        self.assertEqual(len(n), 1, "одинаковые маршруты для всех способов управления")
        for r in self.res.values():
            self.assertGreater(r.mean_wait, 0)
            self.assertIsNotNone(r.through_time_eb)
            self.assertEqual(set(r.queue_by_node), {n.id for n in C.nodes})
            self.assertTrue(all(0 <= v <= 1.5 for v in r.max_fill.values()))
            self.assertTrue(r.decision_reasons)

    def test_spillback_measured_in_incident(self):
        """Перекрытый выезд: очередь доходит до предыдущего перекрёстка, и это видно в метриках; без нарушений безопасности."""
        r = run_corridor(C, "adaptive", "incident", 4, duration=600, drain=900, flows=INCIDENT["flows"], closures=INCIDENT["closures"],
                         teleport_s=INCIDENT["teleport_s"], work_dir=self.work)
        self.assertGreater(r.spill_seconds["KUL_to_BEI"], 0)
        self.assertGreater(r.max_fill["KUL_to_BEI"], 0.8)
        self.assertEqual((r.collisions, r.teleports, r.conflict_steps, r.unfinished), (0, 0, 0, 0))
        self.assertGreater(r.clearance_hold_s, 0, "страж держал «все красные», пока в зоне перекрёстка стояла машина")
        self.assertEqual(sum(self.res["adaptive"].spill_seconds.values()), 0, "при обычной нагрузке очередь соседа не достаёт")

    def test_reproducible(self):
        again = run_corridor(C, "adaptive", "medium", 5, duration=600, drain=900, work_dir=Path(tempfile.mkdtemp()))
        r = self.res["adaptive"]
        for f in ("mean_wait", "through_time_eb", "through_time_wb", "switches", "completed"):
            self.assertEqual(getattr(again, f), getattr(r, f), f)


if __name__ == "__main__":
    unittest.main()
