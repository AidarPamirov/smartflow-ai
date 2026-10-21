"""Алгоритмы управления светофором. Ничего не знают о SUMO, TraCI и визуализации.

Структура:
  SignalPlan        — фазы → состояние сигнала по индексам связей (как в SUMO: 'G', 'y', 'r');
                      при создании проверяет, что в одной фазе нет зелёного конфликтующим связям.
  SignalSupervisor  — единственный, кто меняет сигнал: минимальный зелёный, жёлтый, «все красные»,
                      абсолютный максимум зелёного. Переход «зелёный → другой зелёный» без жёлтого
                      и «все красные» невозможен по построению.
  FixedTimeController, AdaptiveController — только выбирают, какую фазу хотят следующей.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping, Protocol, Sequence

APPROACHES = ("N", "E", "S", "W")
TURNS = ("L", "T", "R")


class UnsafePlanError(ValueError):
    """План фаз даёт одновременный зелёный конфликтующим связям или кого-то не обслуживает."""


@dataclass(frozen=True)
class Movement:
    approach: str  # откуда едет машина: N — с севера (на юг) и т. д.
    turn: str  # L — налево, T — прямо, R — направо

    def __str__(self) -> str:
        return f"{self.approach}{self.turn}"


@dataclass(frozen=True)
class Phase:
    name: str
    movements: frozenset[Movement]


@dataclass(frozen=True)
class Timing:
    min_green: float = 8.0
    yellow: float = 3.0
    all_red: float = 2.0
    #: Абсолютный предел зелёного, который страж соблюдает независимо от контроллера (защита от «зависания»).
    hard_max_green: float = 120.0


@dataclass(frozen=True)
class Link:
    """Связь светофора: индекс в строке состояния SUMO, входная полоса, манёвр."""
    index: int
    in_lane: str
    movement: Movement


class SignalPlan:
    def __init__(self, links: Sequence[Link], phases: Sequence[Phase], foes: Iterable[tuple[int, int]]):
        self.links = sorted(links, key=lambda l: l.index)
        if [l.index for l in self.links] != list(range(len(self.links))):
            raise UnsafePlanError("индексы связей должны идти подряд с 0")
        self.phases = list(phases)
        self.foes = {(a, b) for a, b in foes} | {(b, a) for a, b in foes}
        self.green_links: list[frozenset[int]] = [
            frozenset(l.index for l in self.links if l.movement in ph.movements) for ph in self.phases
        ]
        self._validate()
        #: Входные полосы, у которых есть зелёный в фазе (по ним контроллер оценивает спрос).
        self.phase_lanes: list[frozenset[str]] = [
            frozenset(self.links[i].in_lane for i in g) for g in self.green_links
        ]

    def _validate(self) -> None:
        for k, g in enumerate(self.green_links):
            if not g:
                raise UnsafePlanError(f"фаза {self.phases[k].name} не открывает ни одной связи")
            for a in g:
                for b in g:
                    if a < b and (a, b) in self.foes:
                        raise UnsafePlanError(
                            f"фаза {self.phases[k].name}: конфликтующие связи {a} ({self.links[a].movement}) "
                            f"и {b} ({self.links[b].movement}) получают зелёный одновременно")
        served = set().union(*self.green_links)
        missing = [l for l in self.links if l.index not in served]
        if missing:
            raise UnsafePlanError("не обслуживаются связи: " + ", ".join(f"{l.index} ({l.movement})" for l in missing))

    @property
    def n(self) -> int:
        return len(self.phases)

    def state(self, phase: int, stage: str) -> str:
        """Строка состояния SUMO: 'G' — зелёный с приоритетом, 'y' — жёлтый, 'r' — красный."""
        g = self.green_links[phase]
        if stage == "green":
            return "".join("G" if i in g else "r" for i in range(len(self.links)))
        if stage == "yellow":
            return "".join("y" if i in g else "r" for i in range(len(self.links)))
        return "r" * len(self.links)

    def conflicting_greens(self, state: str) -> list[tuple[int, int]]:
        """Пары конфликтующих связей, у которых в состоянии одновременно зелёный (должен быть пустой список)."""
        green = [i for i, c in enumerate(state) if c in "Gg"]
        return [(a, b) for a in green for b in green if a < b and (a, b) in self.foes]


@dataclass
class Observation:
    """Наблюдение за перекрёстком на текущем шаге (заполняет runner из TraCI)."""
    time: float
    #: стоящих машин на полосе (скорость < 0,1 м/с)
    queue: Mapping[str, int] = field(default_factory=dict)
    #: суммарное накопленное ожидание машин на полосе, с
    wait: Mapping[str, float] = field(default_factory=dict)
    #: движущихся машин в зоне детектора перед стоп-линией
    approaching: Mapping[str, int] = field(default_factory=dict)


class Controller(Protocol):
    name: str

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        """Фаза, которую контроллер хочет включить следующей, или None — продолжать текущую."""


class SignalSupervisor:
    """Конечный автомат сигнала: green → yellow → all-red → green. Только он формирует состояние."""

    def __init__(self, plan: SignalPlan, timing: Timing, initial_phase: int = 0):
        if not 0 <= initial_phase < plan.n:
            raise ValueError("нет такой фазы")
        if timing.min_green <= 0 or timing.yellow < 3 or timing.all_red < 1:
            raise ValueError("небезопасные интервалы: жёлтый ≥ 3 с, «все красные» ≥ 1 с, минимальный зелёный > 0")
        self.plan = plan
        self.timing = timing
        self.phase = initial_phase
        self.next_phase = initial_phase
        self.stage = "green"
        self.elapsed = 0.0  # время в текущей стадии
        self.switches = 0

    @property
    def state(self) -> str:
        return self.plan.state(self.phase, self.stage)

    @property
    def green_elapsed(self) -> float:
        return self.elapsed if self.stage == "green" else 0.0

    def step(self, dt: float, request: int | None) -> str:
        """Продвигает время на dt и учитывает запрос контроллера. Возвращает состояние на следующий интервал."""
        eps = 1e-9
        self.elapsed += dt
        t = self.timing
        if self.stage == "green":
            want = request is not None and request != self.phase and 0 <= request < self.plan.n
            forced = self.elapsed >= t.hard_max_green - eps
            if (want and self.elapsed >= t.min_green - eps) or forced:
                self.next_phase = request if want else (self.phase + 1) % self.plan.n
                self.stage = "yellow"
                self.elapsed = 0.0
                self.switches += 1
        elif self.stage == "yellow":
            if self.elapsed >= t.yellow - eps:
                self.stage = "allred"
                self.elapsed = 0.0
        elif self.elapsed >= t.all_red - eps:
            self.phase = self.next_phase
            self.stage = "green"
            self.elapsed = 0.0
        return self.state


class FixedTimeController:
    """Фиксированный цикл: фазы по кругу, у каждой своя длительность зелёного."""

    name = "fixed"

    def __init__(self, greens: Sequence[float]):
        if any(g <= 0 for g in greens):
            raise ValueError("длительности зелёного должны быть > 0")
        self.greens = list(greens)

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        if len(self.greens) != plan.n:
            raise ValueError("число длительностей не совпадает с числом фаз")
        return (phase + 1) % plan.n if green_elapsed >= self.greens[phase] - 1e-9 else None


@dataclass
class AdaptiveParams:
    #: общий предел зелёного, с; если задан max_green_by_phase — используется он
    max_green: float = 45.0
    #: предел по фазам (обычно 1,5 × зелёного из расчётного плана), с
    max_green_by_phase: tuple[float, ...] | None = None
    #: сколько секунд ожидания эквивалентны одной стоящей машине (при выборе следующей фазы)
    wait_weight: float = 20.0
    #: фаза со спросом, не получавшая зелёного дольше этого, обслуживается вне очереди, с
    starvation: float = 120.0


class AdaptiveController:
    """Адаптивное (актуированное) управление по очередям и ожиданию, без машинного обучения.

    Продление: зелёный продолжается, пока на полосах текущей фазы есть стоящая очередь или машины
    в зоне детектора перед стоп-линией (поток не прервался), но не дольше max_green.
    Завершение: «разрыв потока» (очередь разъехалась и в детекторе пусто), достигнут max_green
    или какая-то фаза со спросом ждёт дольше starvation. Если у других фаз спроса нет — зелёный продлевается.
    Выбор следующей фазы: наибольшее давление = Σ по полосам (стоящие + ожидание / wait_weight);
    фазы без спроса пропускаются. Минимальный зелёный, жёлтый и «все красные» обеспечивает страж.
    """

    name = "adaptive"

    def __init__(self, params: AdaptiveParams | None = None):
        self.p = params or AdaptiveParams()
        self._last_green: dict[int, float] = {}

    def pressure(self, k: int, obs: Observation, plan: SignalPlan) -> float:
        lanes = plan.phase_lanes[k]
        return sum(obs.queue.get(l, 0) + obs.wait.get(l, 0.0) / self.p.wait_weight for l in lanes)

    def demand(self, k: int, obs: Observation, plan: SignalPlan) -> bool:
        lanes = plan.phase_lanes[k]
        return any(obs.queue.get(l, 0) > 0 or obs.approaching.get(l, 0) > 0 for l in lanes)

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        self._last_green[phase] = obs.time
        others = [k for k in range(plan.n) if k != phase and self.demand(k, obs, plan)]
        if not others:
            return None  # больше никого нет — продлеваем текущую фазу
        pres = {k: self.pressure(k, obs, plan) for k in others}
        # при равном давлении — следующая по кругу
        best = max(others, key=lambda k: (pres[k], -((k - phase) % plan.n)))
        starving = [k for k in others if obs.time - self._last_green.get(k, 0.0) >= self.p.starvation]
        if starving:
            return max(starving, key=lambda k: obs.time - self._last_green.get(k, 0.0))
        limit = self.p.max_green_by_phase[phase] if self.p.max_green_by_phase else self.p.max_green
        if green_elapsed >= limit:
            return best
        if not self.demand(phase, obs, plan):
            return best  # разрыв потока: очередь разъехалась, в детекторе пусто
        return None


def tick(sup: SignalSupervisor, ctrl: Controller, obs: Observation, dt: float) -> str:
    """Один шаг управления: контроллер видит зелёный с учётом наступающего шага, страж решает.

    Контроллер опрашивается только на зелёном; на жёлтом и «все красные» страж ведёт переход сам.
    """
    req = ctrl.request(sup.phase, sup.green_elapsed + dt, obs, sup.plan) if sup.stage == "green" else None
    return sup.step(dt, req)
