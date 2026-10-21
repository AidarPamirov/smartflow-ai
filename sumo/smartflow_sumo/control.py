"""Алгоритмы управления светофором. Ничего не знают о SUMO, TraCI и визуализации.

Структура:
  SignalPlan        — фазы → состояние сигнала по индексам связей (как в SUMO: 'G', 'y', 'r');
                      при создании проверяет, что в одной фазе нет зелёного конфликтующим связям.
  SignalSupervisor  — единственный, кто меняет сигнал: минимальный зелёный, жёлтый, «все красные»,
                      абсолютный максимум зелёного. Переход «зелёный → другой зелёный» без жёлтого
                      и «все красные» невозможен по построению.
  FixedTimeController, AdaptiveController — только выбирают, какую фазу хотят следующей,
                      и объясняют выбор (last_reason) для журнала решений.
  SafeController    — обёртка: при исключении, неверном ответе или отсутствии данных датчиков
                      переключается на заранее заданный фиксированный план и больше к основному не возвращается.
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
    """Наблюдение за перекрёстком на текущем шаге (заполняет runner из TraCI).

    Значение None у полосы — датчик не дал данных (неисправность); контроллер такие данные не принимает.
    """
    time: float
    #: стоящих машин на полосе (скорость < 0,1 м/с)
    queue: Mapping[str, int | None] = field(default_factory=dict)
    #: суммарное накопленное ожидание машин на полосе, с
    wait: Mapping[str, float | None] = field(default_factory=dict)
    #: движущихся машин в зоне детектора перед стоп-линией
    approaching: Mapping[str, int | None] = field(default_factory=dict)
    #: в зоне перекрёстка стоит или почти стоит машина (выезд занят очередью) — следующий зелёный давать нельзя
    box_blocked: bool = False


class SensorError(ValueError):
    """Нет данных или неверные данные датчиков."""


def check_observation(obs: Observation, lanes: Iterable[str]) -> None:
    """Бросает SensorError, если датчик полосы сообщил «нет данных» (None) или отрицательное значение.

    Полоса, которой нет в наблюдении, считается пустой (0): так задаются наблюдения в тестах.
    """
    for l in lanes:
        for name, m in (("очередь", obs.queue), ("ожидание", obs.wait), ("подъезжающие", obs.approaching)):
            v = m.get(l, 0)
            if v is None or v < 0:
                raise SensorError(f"нет данных датчика «{name}» на полосе {l}")


@dataclass(frozen=True)
class Decision:
    """Запись журнала: смена фазы и её причина."""
    time: float
    from_phase: int
    to_phase: int
    controller: str
    reason: str


class Controller(Protocol):
    name: str
    #: почему был сделан последний запрос смены фазы (для журнала)
    last_reason: str

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
        #: сколько секунд «все красные» продлевались, потому что в зоне перекрёстка стояла машина
        self.clearance_hold_s = 0.0

    @property
    def state(self) -> str:
        return self.plan.state(self.phase, self.stage)

    @property
    def green_elapsed(self) -> float:
        return self.elapsed if self.stage == "green" else 0.0

    def step(self, dt: float, request: int | None, box_blocked: bool = False) -> str:
        """Продвигает время на dt и учитывает запрос контроллера. Возвращает состояние на следующий интервал.

        box_blocked — в зоне перекрёстка стоит машина (выехать ей некуда): «все красные» продлеваются,
        пока зона не освободится, иначе поток следующей фазы въедет в неё сбоку.
        """
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
        elif self.elapsed >= t.all_red - eps and box_blocked:
            self.clearance_hold_s += dt
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
        self.last_reason = ""

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        if len(self.greens) != plan.n:
            raise ValueError("число длительностей не совпадает с числом фаз")
        if green_elapsed >= self.greens[phase] - 1e-9:
            self.last_reason = f"фиксированный план: зелёный {self.greens[phase]:g} с"
            return (phase + 1) % plan.n
        return None


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
        self.last_reason = ""

    def pressure(self, k: int, obs: Observation, plan: SignalPlan) -> float:
        lanes = plan.phase_lanes[k]
        return sum(obs.queue.get(l, 0) + obs.wait.get(l, 0.0) / self.p.wait_weight for l in lanes)

    def demand(self, k: int, obs: Observation, plan: SignalPlan) -> bool:
        lanes = plan.phase_lanes[k]
        return any(obs.queue.get(l, 0) > 0 or obs.approaching.get(l, 0) > 0 for l in lanes)

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        check_observation(obs, set().union(*plan.phase_lanes))
        self._last_green[phase] = obs.time
        others = [k for k in range(plan.n) if k != phase and self.demand(k, obs, plan)]
        if not others:
            return None  # больше никого нет — продлеваем текущую фазу
        pres = {k: self.pressure(k, obs, plan) for k in others}
        # при равном давлении — следующая по кругу
        best = max(others, key=lambda k: (pres[k], -((k - phase) % plan.n)))
        why_best = f"следующая — фаза {best + 1}: давление {pres[best]:.1f} (очередь + ожидание / {self.p.wait_weight:g} с)"
        starving = [k for k in others if obs.time - self._last_green.get(k, 0.0) >= self.p.starvation]
        if starving:
            k = max(starving, key=lambda k: obs.time - self._last_green.get(k, 0.0))
            self.last_reason = f"защита от голодания: фаза {k + 1} без зелёного {obs.time - self._last_green.get(k, 0.0):.0f} с"
            return k
        limit = self.p.max_green_by_phase[phase] if self.p.max_green_by_phase else self.p.max_green
        if green_elapsed >= limit:
            self.last_reason = f"максимум зелёного фазы {limit:g} с; {why_best}"
            return best
        if not self.demand(phase, obs, plan):
            self.last_reason = f"разрыв потока: на фазе {phase + 1} нет очереди и в {30} м никто не подъезжает; {why_best}"
            return best
        return None


class SafeController:
    """Основной контроллер с безопасным резервом.

    Если основной контроллер бросил исключение, вернул недопустимую фазу или датчики не дали данных,
    управление навсегда переходит к резервному фиксированному плану (fallback), а причина записывается.
    Сам переход сигналов по-прежнему делает SignalSupervisor: конфликтующих зелёных не бывает и при сбое.
    """

    def __init__(self, primary: Controller, fallback: FixedTimeController):
        self.primary = primary
        self.fallback = fallback
        self.name = primary.name
        self.failed_at: float | None = None
        self.failure: str | None = None
        self.last_reason = ""

    @property
    def active(self) -> str:
        return self.primary.name if self.failed_at is None else f"{self.fallback.name} (резерв)"

    def request(self, phase: int, green_elapsed: float, obs: Observation, plan: SignalPlan) -> int | None:
        if self.failed_at is None:
            try:
                k = self.primary.request(phase, green_elapsed, obs, plan)
                if k is not None and not (isinstance(k, int) and 0 <= k < plan.n):
                    raise ValueError(f"недопустимая фаза {k!r}")
                self.last_reason = self.primary.last_reason
                return k
            except Exception as e:  # noqa: BLE001 — любой сбой контроллера ведёт в резервный план
                self.failed_at = obs.time
                self.failure = f"{type(e).__name__}: {e}"
        k = self.fallback.request(phase, green_elapsed, obs, plan)
        self.last_reason = f"резервный план после сбоя ({self.failure}); {self.fallback.last_reason}"
        return k


def tick(sup: SignalSupervisor, ctrl: Controller, obs: Observation, dt: float, log: list[Decision] | None = None) -> str:
    """Один шаг управления: контроллер видит зелёный с учётом наступающего шага, страж решает.

    Контроллер опрашивается только на зелёном; на жёлтом и «все красные» страж ведёт переход сам.
    Каждая смена фазы записывается в log с причиной: решение контроллера или жёсткий максимум стража.
    """
    req = ctrl.request(sup.phase, sup.green_elapsed + dt, obs, sup.plan) if sup.stage == "green" else None
    was_green, phase = sup.stage == "green", sup.phase
    hold_before = sup.clearance_hold_s
    held_last = getattr(sup, "_held_last", False)
    state = sup.step(dt, req, box_blocked=getattr(obs, "box_blocked", False))
    held = sup.clearance_hold_s > hold_before
    sup._held_last = held
    if log is not None and held and not held_last:
        log.append(Decision(obs.time, phase, sup.next_phase, "страж", "продление «все красные»: в зоне перекрёстка стоит машина"))
    if log is not None and was_green and sup.stage == "yellow":
        by_ctrl = req is not None and req == sup.next_phase
        reason = getattr(ctrl, "last_reason", "") if by_ctrl else f"страж: жёсткий максимум зелёного {sup.timing.hard_max_green:g} с"
        log.append(Decision(obs.time, phase, sup.next_phase, getattr(ctrl, "active", ctrl.name), reason))
    return state
