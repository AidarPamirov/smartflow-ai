"""Алгоритмы управления без SUMO: план фаз, страж безопасности, фиксированный и адаптивный контроллеры."""
import itertools
import unittest

from smartflow_sumo.build import webster_greens
from smartflow_sumo.control import (AdaptiveController, AdaptiveParams, FixedTimeController, Link, Movement, Observation,
                                    Phase, SignalPlan, SignalSupervisor, Timing, UnsafePlanError, tick)

M = Movement
# Упрощённый перекрёсток: 4 связи «прямо» по одной полосе на подход. N/S конфликтуют с E/W.
LINKS = [Link(0, "N_in_0", M("N", "T")), Link(1, "S_in_0", M("S", "T")), Link(2, "E_in_0", M("E", "T")), Link(3, "W_in_0", M("W", "T"))]
FOES = {(0, 2), (0, 3), (1, 2), (1, 3)}
PHASES = [Phase("NS", frozenset({M("N", "T"), M("S", "T")})), Phase("EW", frozenset({M("E", "T"), M("W", "T")}))]


def plan() -> SignalPlan:
    return SignalPlan(LINKS, PHASES, FOES)


def obs(t, **queues):
    return Observation(time=t, queue={f"{k}_in_0": v for k, v in queues.items()}, wait={}, approaching={})


class PlanTests(unittest.TestCase):
    def test_conflicting_phase_rejected(self):
        bad = [Phase("всё сразу", frozenset({M("N", "T"), M("E", "T")})), PHASES[1]]
        with self.assertRaises(UnsafePlanError):
            SignalPlan(LINKS, bad, FOES)

    def test_unserved_link_rejected(self):
        with self.assertRaises(UnsafePlanError):
            SignalPlan(LINKS, PHASES[:1], FOES)

    def test_states(self):
        p = plan()
        self.assertEqual(p.state(0, "green"), "GGrr")
        self.assertEqual(p.state(1, "yellow"), "rryy")
        self.assertEqual(p.state(0, "allred"), "rrrr")
        self.assertEqual(p.conflicting_greens("GGrr"), [])
        self.assertEqual(p.conflicting_greens("GrGr"), [(0, 2)])
        self.assertEqual(p.phase_lanes[1], frozenset({"E_in_0", "W_in_0"}))


class SupervisorTests(unittest.TestCase):
    def run_sequence(self, ctrl, steps, timing=Timing(), queues=None):
        sup = SignalSupervisor(plan(), timing)
        states = [sup.state]
        for t in range(1, steps + 1):
            q = queues(t) if queues else {"N": 3, "S": 3, "E": 3, "W": 3}
            states.append(tick(sup, ctrl, obs(t, **q), 1.0))
        return states

    @staticmethod
    def segments(states):
        return [(s, len(list(g))) for s, g in itertools.groupby(states)]

    def test_switch_requires_min_green_yellow_allred(self):
        class Eager:  # контроллер, который всё время требует другую фазу
            name = "eager"
            def request(self, phase, green_elapsed, o, p):
                return (phase + 1) % p.n
        states = self.run_sequence(Eager(), 120, Timing(min_green=8, yellow=3, all_red=2))
        segs = self.segments(states)
        for (s, n), (s2, _) in zip(segs, segs[1:]):
            if "G" in s:
                self.assertGreaterEqual(n, 8, "зелёный короче минимального")
                self.assertTrue(set(s2) <= {"y", "r"} and "y" in s2, "после зелёного сразу не жёлтый")
            if "y" in s:
                self.assertEqual(n, 3)
                self.assertEqual(set(s2), {"r"}, "после жёлтого не «все красные»")
            if set(s) == {"r"}:
                self.assertEqual(n, 2)
        # ни в одном состоянии нет конфликтующих зелёных
        self.assertTrue(all(plan().conflicting_greens(s) == [] for s in states))

    def test_hard_max_green(self):
        class Never:
            name = "never"
            def request(self, *a):
                return None
        states = self.run_sequence(Never(), 300, Timing(hard_max_green=60))
        greens = [n for s, n in self.segments(states) if "G" in s]
        self.assertTrue(all(n <= 60 for n in greens[:-1]))

    def test_unsafe_timing_rejected(self):
        with self.assertRaises(ValueError):
            SignalSupervisor(plan(), Timing(yellow=2))

    def test_fixed_cycle_durations(self):
        states = self.run_sequence(FixedTimeController([20, 12]), 200)
        segs = self.segments(states)[:-1]
        greens = [(s, n) for s, n in segs if "G" in s]
        self.assertEqual(greens[0], ("GGrr", 20))
        self.assertEqual(greens[1], ("rrGG", 12))
        self.assertEqual(greens[2], ("GGrr", 20))
        cycle = sum(n for _, n in segs[:6])
        self.assertEqual(cycle, 20 + 12 + 2 * (3 + 2))


class AdaptiveTests(unittest.TestCase):
    def test_extends_when_no_other_demand(self):
        c = AdaptiveController(AdaptiveParams(max_green=30))
        self.assertIsNone(c.request(0, 100, obs(100, N=5, S=0, E=0, W=0), plan()))

    def test_gap_out_to_highest_pressure(self):
        c = AdaptiveController()
        self.assertEqual(c.request(0, 10, obs(10, N=0, S=0, E=4, W=1), plan()), 1)

    def test_keeps_green_while_queue_discharges(self):
        c = AdaptiveController(AdaptiveParams(max_green=40))
        self.assertIsNone(c.request(0, 15, obs(15, N=3, S=0, E=10, W=10), plan()))

    def test_max_green_by_phase(self):
        c = AdaptiveController(AdaptiveParams(max_green_by_phase=(20.0, 50.0)))
        self.assertEqual(c.request(0, 20, obs(20, N=3, E=2), plan()), 1)
        self.assertIsNone(c.request(1, 20, obs(20, N=3, E=2), plan()))

    def test_starvation_guard(self):
        c = AdaptiveController(AdaptiveParams(max_green=1000, starvation=60))
        c.request(1, 10, obs(0, E=1), plan())  # фаза 1 была зелёной в t=0
        self.assertEqual(c.request(0, 70, obs(70, N=9, E=1), plan()), 1)

    def test_in_loop_never_unsafe(self):
        sup = SignalSupervisor(plan(), Timing())
        c = AdaptiveController()
        import random
        rng = random.Random(1)
        for t in range(1, 2000):
            q = {k: rng.randint(0, 6) for k in "NSEW"}
            s = tick(sup, c, obs(t, **q), 1.0)
            self.assertEqual(plan().conflicting_greens(s), [])


class WebsterTests(unittest.TestCase):
    def test_greens_proportional_and_bounded(self):
        cycle, greens = webster_greens(plan(), {"N_in_0": 600, "S_in_0": 300, "E_in_0": 300, "W_in_0": 300})
        self.assertTrue(60 <= cycle <= 120)
        self.assertGreater(greens[0], greens[1])
        self.assertTrue(all(g >= 8 and g == int(g) for g in greens))


if __name__ == "__main__":
    unittest.main()
