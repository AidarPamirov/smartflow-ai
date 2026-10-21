"""Интерфейс данных для веба: запись прогона SUMO в JSON формата smartflow-sumo-trace/1.

Формат описан в sumo/trace.schema.json; та же проверка повторена в TypeScript (src/sumo/trace.ts).

  meta      — сценарий, контроллер, нагрузка, seed, версия SUMO, окно записи, оговорка о приближениях
  geometry  — полосы и контур перекрёстка (метры, система координат сети SUMO), стоп-линии связей
  phases    — фазы плана: название и манёвры
  frames    — кадры с шагом sample_s: время, строка сигнала SUMO, фаза, стадия, машины
              v = [id, x, y, angle, speed, …] — плоский массив по 5 чисел на машину
  summary   — метрики прогона
"""
from __future__ import annotations

import datetime as _dt
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

FORMAT = "smartflow-sumo-trace/1"
APPROXIMATION_NOTE = (
    "Схематизированная модель: направления улиц, число полос и разрешённые манёвры взяты из OpenStreetMap или "
    "указаны как допущения (см. sumo/scenario). Подходы прямые, точная геометрия бордюров и разметки не "
    "воспроизводится; спрос синтетический; план фаз — инженерный, а не план реального светофора."
)


def _flat(shape: str) -> list[float]:
    out: list[float] = []
    for p in shape.split():
        x, y = p.split(",")[:2]
        out += [round(float(x), 2), round(float(y), 2)]
    return out


class TraceRecorder:
    def __init__(self, window: tuple[float, float], sample_s: float = 1.0):
        if window[1] <= window[0] or sample_s <= 0:
            raise ValueError("неверное окно записи")
        self.window = window
        self.sample = sample_s
        self.data: dict[str, Any] = {}
        self._ids: dict[str, int] = {}

    def begin(self, net: Path, plan, plan_name: str, sc, controller: str, load: str, seed: int) -> None:
        root = ET.parse(net).getroot()
        lanes = []
        for e in root.findall("edge"):
            if e.get("function") == "internal":
                continue
            for l in e.findall("lane"):
                lanes.append({"id": l.get("id"), "shape": _flat(l.get("shape")), "width": float(l.get("width", 3.2))})
        j = root.find("junction[@id='C']")
        junction = _flat(j.get("shape"))
        lane_end = {l["id"]: l["shape"][-2:] for l in lanes}
        links = [{"index": l.index, "movement": str(l.movement), "in_lane": l.in_lane,
                  "x": lane_end[l.in_lane][0], "y": lane_end[l.in_lane][1]} for l in plan.links]
        xs = [v for l in lanes for v in l["shape"][0::2]]
        ys = [v for l in lanes for v in l["shape"][1::2]]
        try:
            import traci
            version = traci.getVersion()[1]
        except Exception:  # noqa: BLE001
            version = "unknown"
        self.data = {
            "format": FORMAT,
            "meta": {
                "scenario": sc.id, "title": sc.title, "controller": controller, "load": load, "seed": seed,
                "plan": plan_name, "sumo_version": version, "sample_s": self.sample, "window": list(self.window),
                "center": {"lat": sc.center_lat, "lon": sc.center_lon},
                "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                "approximation_note": APPROXIMATION_NOTE,
            },
            "geometry": {"bounds": [min(xs), min(ys), max(xs), max(ys)], "lanes": lanes, "junction": junction, "links": links},
            "phases": [{"name": p.name, "movements": sorted(str(m) for m in p.movements)} for p in plan.phases],
            "frames": [],
            "summary": {},
        }

    def frame(self, tc, t: float, sup) -> None:
        w0, w1 = self.window
        if t < w0 - 1e-9 or t > w1 + 1e-9:
            return
        k = (t - w0) / self.sample
        if abs(k - round(k)) > 1e-6:
            return
        v: list[float] = []
        for vid in tc.vehicle.getIDList():
            n = self._ids.setdefault(vid, len(self._ids) + 1)
            x, y = tc.vehicle.getPosition(vid)
            v += [n, round(x, 1), round(y, 1), round(tc.vehicle.getAngle(vid)), round(tc.vehicle.getSpeed(vid), 1)]
        self.data["frames"].append({
            "t": round(t, 3), "signal": tc.trafficlight.getRedYellowGreenState("C"),
            "phase": sup.phase, "stage": sup.stage, "v": v,
        })

    def end(self, summary: dict) -> None:
        self.data["summary"] = summary

    def write(self, path: Path) -> None:
        errs = validate_trace(self.data)
        if errs:
            raise ValueError("запись не прошла проверку формата: " + "; ".join(errs[:5]))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def validate_trace(d: Any) -> list[str]:
    """Проверка формата без сторонних библиотек. Пустой список — запись корректна."""
    e: list[str] = []
    if not isinstance(d, dict) or d.get("format") != FORMAT:
        return [f"format должен быть {FORMAT}"]
    m = d.get("meta", {})
    for k in ("scenario", "controller", "load", "seed", "sample_s", "window", "sumo_version", "approximation_note"):
        if k not in m:
            e.append(f"meta.{k} отсутствует")
    if m.get("controller") not in ("fixed", "adaptive"):
        e.append("meta.controller: fixed или adaptive")
    g = d.get("geometry", {})
    lanes = g.get("lanes", [])
    if not lanes:
        e.append("geometry.lanes пуст")
    for l in lanes:
        s = l.get("shape", [])
        if len(s) < 4 or len(s) % 2:
            e.append(f"полоса {l.get('id')}: неверная форма")
    links = g.get("links", [])
    if [x.get("index") for x in links] != list(range(len(links))):
        e.append("geometry.links: индексы должны идти подряд с 0")
    n_links = len(links)
    phases = d.get("phases", [])
    if not phases:
        e.append("phases пуст")
    frames = d.get("frames", [])
    if not frames:
        e.append("frames пуст")
    prev = None
    for i, f in enumerate(frames):
        sig = f.get("signal", "")
        if len(sig) != n_links or any(c not in "GgyrRuoO" for c in sig):
            e.append(f"кадр {i}: строка сигнала не соответствует связям")
            break
        if f.get("stage") not in ("green", "yellow", "allred"):
            e.append(f"кадр {i}: неизвестная стадия")
            break
        if not 0 <= f.get("phase", -1) < len(phases):
            e.append(f"кадр {i}: неверная фаза")
            break
        v = f.get("v", [])
        if len(v) % 5:
            e.append(f"кадр {i}: v должно содержать по 5 чисел на машину")
            break
        if prev is not None and f["t"] <= prev:
            e.append(f"кадр {i}: время не возрастает")
            break
        prev = f["t"]
    return e
