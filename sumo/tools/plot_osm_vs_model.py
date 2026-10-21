#!/usr/bin/env python3
"""Наложение: линии OSM вокруг перекрёстка и полосы сети SUMO, в одних локальных метрах.

    python sumo/tools/plot_osm_vs_model.py sumo/scenario/osm/chui-manas.geometry.json sumo/docs/chui-manas-osm-vs-model.png

Нужен matplotlib и собранная сеть (python -m smartflow_sumo.build или любой прогон тестов).
Картинка — для глаз: насколько схема одного узла отличается от реальной разметки дорог.
"""
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from smartflow_sumo.build import BUILD_DIR, build_net, load_scenario  # noqa: E402

M_PER_DEG = 111_195


def main(geo_path: str, out_path: str, scenario: str = "chui-manas") -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sc = load_scenario(scenario)
    net = BUILD_DIR / sc.id / "net.net.xml"
    if not net.exists():
        net = build_net(sc)
    geo = json.loads(Path(geo_path).read_text(encoding="utf-8"))
    lat0, lon0 = sc.raw["center"]["lat"], sc.raw["center"]["lon"]
    k = math.cos(math.radians(lat0))

    def xy(lat, lon):
        return (lon - lon0) * k * M_PER_DEG, (lat - lat0) * M_PER_DEG

    fig, ax = plt.subplots(figsize=(9, 9), dpi=110)
    style = {"primary": ("#1f6fd1", 2.2), "secondary": ("#2f9e44", 1.8), "tertiary": ("#8a63d2", 1.6)}
    labelled = set()
    for w in geo["ways"]:
        hw = w["tags"].get("highway", "")
        base = hw.replace("_link", "")
        col, lw = style.get(base, ("#888888", 1.2))
        pts = [xy(a, b) for a, b in w["geometry"]]
        lab = f"OSM {hw}" if hw not in labelled else None
        labelled.add(hw)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=col, lw=lw, ls="--" if hw.endswith("_link") else "-",
                label=lab, zorder=3)
        if w["tags"].get("oneway") == "yes" and len(pts) >= 2:
            i = len(pts) // 2
            (x0, y0), (x1, y1) = pts[i - 1], pts[i]
            ax.annotate("", (x1, y1), (x0, y0), arrowprops={"arrowstyle": "->", "color": col, "lw": 1.2}, zorder=4)
    for s in geo.get("traffic_signals", []):
        x, y = xy(s["lat"], s["lon"])
        ax.plot(x, y, "o", color="#e03131", ms=7, zorder=5, label="OSM светофор" if "sig" not in labelled else None)
        labelled.add("sig")
    root = ET.parse(net).getroot()
    first = True
    for e in root.findall("edge"):
        if e.get("function") == "internal":
            continue
        for ln in e.findall("lane"):
            pts = [tuple(map(float, p.split(","))) for p in ln.get("shape").split()]
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#000000", lw=5, alpha=0.13, solid_capstyle="butt",
                    label="полоса модели SUMO" if first else None, zorder=2)
            first = False
    r = 130
    ax.set_xlim(-r, r)
    ax.set_ylim(-r, r)
    ax.set_aspect("equal")
    ax.grid(alpha=0.25)
    ax.set_xlabel("восток, м")
    ax.set_ylabel("север, м")
    ax.set_title(f"{sc.title}\nOSM ({geo.get('osm_base', '')[:10]}) и модель SUMO в одних координатах", fontsize=10)
    ax.legend(loc="lower left", fontsize=8, framealpha=0.9)
    ax.text(0.99, 0.01, "© OpenStreetMap contributors, ODbL", transform=ax.transAxes, ha="right", va="bottom", fontsize=7, color="#555")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, bbox_inches="tight")
    print(out_path)


if __name__ == "__main__":
    main(*sys.argv[1:3])
