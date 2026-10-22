"""Посмотреть прогон в окне SUMO (sumo-gui): светофором управляет тот же Python-контроллер, что и в эксперименте.

    cd sumo
    python -m smartflow_sumo.watch                                   # адаптивный, средняя нагрузка, seed 1
    python -m smartflow_sumo.watch --controller fixed --load high    # фиксированный цикл при высокой нагрузке
    python -m smartflow_sumo.watch --delay 100 --minutes 10          # медленнее и короче

В окне SUMO: колесо мыши — масштаб, перетаскивание — сдвиг, кнопки ▶/❚❚ — пуск и пауза, поле Delay — скорость.
Нужен компьютер с экраном (на сервере без дисплея окно не откроется). В конце печатаются метрики прогона.
"""
from __future__ import annotations

import argparse

from .build import build_net, load_scenario
from .control import Timing
from .experiment import CONTROLLERS, LOADS, SCENARIO, demand_for, fixed_plan
from .run import run


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Прогон перекрёстка Чуй × Манаса в окне SUMO")
    ap.add_argument("--controller", choices=CONTROLLERS, default="adaptive")
    ap.add_argument("--load", choices=list(LOADS), default="medium")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--minutes", type=float, default=20.0, help="минут спроса")
    ap.add_argument("--delay", type=int, default=50, help="задержка шага в окне, мс (0 — максимально быстро)")
    a = ap.parse_args(argv)
    sc = load_scenario(SCENARIO)
    build_net(sc)
    timing = Timing()
    greens = fixed_plan(sc, timing, a.load if a.controller == "fixed_tuned" else "medium")["greens_s"]
    r = run(sc, a.controller, a.load, demand_for(a.load, a.minutes * 60), a.seed, timing=timing, fixed_greens=greens,
            drain=600.0, gui=True, gui_delay_ms=a.delay)
    print(f"{a.controller}, нагрузка {a.load}, seed {a.seed}: ожидание {r.mean_wait} с, p95 поездки {r.p95_travel_time} с, "
          f"очередь {r.mean_queue} авт, доехали {r.completed}/{r.demand_vehicles}, столкновений {r.collisions}")


if __name__ == "__main__":
    main()
