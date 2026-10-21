"""Адаптивное управление с координацией (без SUMO): «волна» сохраняется, пустые фазы пропускаются,
сэкономленное время достаётся координируемой фазе."""
import unittest

from smartflow_sumo.control import (CoordinatedActuatedController, Link, Movement, Observation, Phase, SafeController,
                                    FixedTimeController, SignalPlan, SignalSupervisor, Timing, tick)
from smartflow_sumo.corridor import place_in_cycle

M = Movement
# Раздельные фазы: N (поперечная улица), E (на запад), W (на восток — координируемая, «волна»)
LINKS = [Link(0, "N_in_0", M("N", "T")), Link(1, "E_in_0", M("E", "T")), Link(2, "W_in_0", M("W", "T"))]
FOES = {(0, 1), (0, 2)}
PHASES = [Phase("N", frozenset({M("N", "T")})), Phase("E", frozenset({M("E", "T")})), Phase("W", frozenset({M("W", "T")}))]
GREENS = [20.0, 25.0, 32.0]
TIMING = Timing()
LOST = TIMING.yellow + TIMING.all_red
CYCLE = sum(GREENS) + 3 * LOST  # 92 с
COORD = 2


def simulate(offset: float, demand, steps: int = 92 * 8):
    """Прогон стража с контроллером; demand(t) → множество фаз со спросом. Возвращает зелёные отрезки (фаза, начало, конец)."""
    plan = SignalPlan(LINKS, PHASES, FOES)
    ctrl = CoordinatedActuatedController(GREENS, CYCLE, offset, COORD, LOST, TIMING.min_green)
    safe = SafeController(ctrl, FixedTimeController(GREENS))
    sup = SignalSupervisor(plan, TIMING)
    ph, st, el = place_in_cycle(GREENS, TIMING, (-offset) % CYCLE)
    sup.phase, sup.next_phase, sup.stage, sup.elapsed = ph, (ph + 1) % plan.n if st != "green" else ph, st, el
    segs, cur = [], None
    for t in range(1, steps + 1):
        want = demand(t)
        q = {f"{d}_in_0": (3 if k in want else 0) for k, d in enumerate("NEW")}
        tick(sup, safe, Observation(time=float(t), queue=q, wait={}, approaching={}), 1.0)
        g = sup.phase if sup.stage == "green" else None
        if g != (cur[0] if cur else None):
            if cur:
                segs.append((cur[0], cur[1], t))
            cur = (g, t) if g is not None else None
    assert safe.failed_at is None, safe.failure
    return segs, ctrl


class CoordinatedActuatedTests(unittest.TestCase):
    def test_saturated_demand_reproduces_fixed_coordinated_plan(self):
        """Спрос на всех фазах всё время → ровно план «зелёной волны»: те же зелёные и то же место в цикле."""
        segs, ctrl = simulate(30.0, lambda t: {0, 1, 2})
        late = [s for s in segs if s[1] > 2 * CYCLE]
        self.assertTrue(late)
        for k, t0, t1 in late[:-1]:
            self.assertAlmostEqual((t1 - t0), GREENS[k], delta=1.0, msg=f"фаза {k}: {t1 - t0} с")
            pos = ctrl.u(t0)
            self.assertLessEqual(min(abs(pos - ctrl.start[k]), CYCLE - abs(pos - ctrl.start[k])), 1.5, f"фаза {k} начинается в {pos:.0f}")

    def test_empty_phase_skipped_and_time_goes_to_coordinated(self):
        """Фазы E нет спроса → она пропускается, координируемая начинается раньше, но заканчивается в своей точке цикла."""
        segs, ctrl = simulate(30.0, lambda t: {0, 2})
        late = [s for s in segs if s[1] > 2 * CYCLE][:-1]
        self.assertFalse(any(k == 1 for k, _, _ in late), "пустая фаза получила зелёный")
        coord = [s for s in late if s[0] == COORD]
        self.assertTrue(coord)
        for _, t0, t1 in coord:
            self.assertGreater(t1 - t0, GREENS[COORD] + 20, "сэкономленное время не досталось координируемой фазе")
            end = ctrl.u(t1)
            self.assertLessEqual(min(abs(end - ctrl.end[COORD]), CYCLE - abs(end - ctrl.end[COORD])), 1.5, f"конец в {end:.0f}")

    def test_no_side_demand_keeps_coordinated_green(self):
        segs, _ = simulate(10.0, lambda t: {2})
        green = sum(t1 - t0 for k, t0, t1 in segs if k == COORD)
        self.assertGreater(green, 0.85 * sum(t1 - t0 for _, t0, t1 in segs))

    def test_side_phase_gaps_out_early(self):
        """Очередь на N есть только первые 10 с её зелёного → фаза заканчивается раньше плана (не 20 с)."""
        state = {"n_start": None}

        def demand(t):
            return {1, 2} | ({0} if state["n_start"] is None or t - state["n_start"] < 10 else set())

        plan = SignalPlan(LINKS, PHASES, FOES)
        ctrl = CoordinatedActuatedController(GREENS, CYCLE, 0.0, COORD, LOST, TIMING.min_green)
        sup = SignalSupervisor(plan, TIMING)
        n_greens = []
        prev = None
        for t in range(1, 92 * 5):
            if sup.stage == "green" and sup.phase == 0 and prev != (0, "green"):
                state["n_start"] = t
            if prev == (0, "green") and not (sup.stage == "green" and sup.phase == 0):
                n_greens.append(t - state["n_start"])
                state["n_start"] = None
            prev = (sup.phase, sup.stage)
            want = demand(t)
            q = {f"{d}_in_0": (3 if k in want else 0) for k, d in enumerate("NEW")}
            tick(sup, ctrl, Observation(time=float(t), queue=q, wait={}, approaching={}), 1.0)
        self.assertTrue(n_greens)
        self.assertTrue(all(g < GREENS[0] - 3 for g in n_greens), n_greens)

    def test_rejects_bad_parameters(self):
        with self.assertRaises(ValueError):
            CoordinatedActuatedController(GREENS, CYCLE, 0.0, 5, LOST)
        with self.assertRaises(ValueError):
            CoordinatedActuatedController([0.0, 10.0], 30.0, 0.0, 0, LOST)


if __name__ == "__main__":
    unittest.main()
