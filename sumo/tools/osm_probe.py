#!/usr/bin/env python3
"""Сбор фактов об одном перекрёстке из OpenStreetMap (Overpass API).

    python sumo/tools/osm_probe.py "Чуй проспект" "проспект Манаса" > probe.json

Ищет узлы, общие для двух улиц, и выводит линии, проходящие через них (теги lanes, oneway,
turn:lanes, maxspeed, начальная геометрия), а также светофоры в радиусе 60 м.
Только сбор фактов: модель SUMO строится отдельно (sumo/scenario/*.json), с явными допущениями.
Данные © OpenStreetMap contributors, ODbL.
"""
import json
import math
import sys
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
BBOX = "42.83,74.54,42.90,74.68"
UA = "SmartFlowAI-osm-probe/1.0 (https://github.com/AidarPamirov/smartflow-ai)"
TAGS = ("highway", "name", "oneway", "lanes", "lanes:forward", "lanes:backward", "turn:lanes",
        "turn:lanes:forward", "turn:lanes:backward", "maxspeed", "junction", "dual_carriageway")


def overpass(q: str) -> dict:
    err = []
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            err.append(f"{url}: {e}")
    raise SystemExit("Overpass недоступен: " + "; ".join(err))


def bearing(a, b) -> float:
    """Азимут из точки a в точку b, градусы от севера по часовой стрелке."""
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dx = (b["lon"] - a["lon"]) * math.cos(lat)
    dy = b["lat"] - a["lat"]
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def dist(a, b) -> float:
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    return math.hypot((b["lon"] - a["lon"]) * math.cos(lat), b["lat"] - a["lat"]) * 111_195


def probe(street_a: str, street_b: str) -> dict:
    q = f"""[out:json][timeout:90];
way[highway][name="{street_a}"]({BBOX})->.a;
way[highway][name="{street_b}"]({BBOX})->.b;
node(w.a)->.na; node(w.b)->.nb;
node.na.nb->.x;
(.x; way(bn.x)[highway]; node(around.x:60)[highway=traffic_signals]; way(around.x:80)[highway~"^(primary|secondary|tertiary|trunk)(_link)?$"];);
out body geom;"""
    data = overpass(q)
    shared = [e for e in data["elements"] if e["type"] == "node" and e.get("tags", {}).get("highway") != "traffic_signals"]
    signals = [e for e in data["elements"] if e["type"] == "node" and e.get("tags", {}).get("highway") == "traffic_signals"]
    ways = [e for e in data["elements"] if e["type"] == "way"]
    center = None
    if shared:
        center = {"lat": sum(n["lat"] for n in shared) / len(shared), "lon": sum(n["lon"] for n in shared) / len(shared)}
    out_ways = []
    for w in ways:
        g = w.get("geometry", [])
        if len(g) < 2 or center is None:
            continue
        # ближайшая к центру точка линии и направление «от центра» по линии на ~60 м
        i0 = min(range(len(g)), key=lambda i: dist(center, g[i]))
        arms = []
        for step in (1, -1):
            j, acc = i0, 0.0
            while 0 <= j + step < len(g) and acc < 60:
                acc += dist(g[j], g[j + step])
                j += step
            if j != i0:
                arms.append({"toward_index": step, "bearing_from_center": round(bearing(g[i0], g[j]), 1), "length_m": round(acc, 1)})
        out_ways.append({
            "id": w["id"],
            "tags": {k: v for k, v in w.get("tags", {}).items() if k in TAGS},
            "nearest_point_to_center_m": round(dist(center, g[i0]), 1),
            "arms": arms,
        })
    return {
        "query": [street_a, street_b],
        "osm_base": data.get("osm3s", {}).get("timestamp_osm_base"),
        "shared_nodes": [{"id": n["id"], "lat": n["lat"], "lon": n["lon"], "tags": n.get("tags", {})} for n in shared],
        "center": center,
        "traffic_signals_within_60m": [{"id": n["id"], "lat": n["lat"], "lon": n["lon"], "dist_m": round(dist(center, n), 1) if center else None} for n in signals],
        "ways": sorted(out_ways, key=lambda w: w["nearest_point_to_center_m"]),
        "attribution": "© OpenStreetMap contributors, ODbL",
    }


if __name__ == "__main__":
    pairs = [sys.argv[1:3]] if len(sys.argv) >= 3 else [
        ["Чуй проспект", "проспект Манаса"],
        ["Чуй проспект", "улица Юсупа Абдрахманова"],
        ["проспект Манаса", "Киевская улица"],
        ["проспект Манаса", "улица Токтогула"],
        ["Киевская улица", "улица Юсупа Абдрахманова"],
    ]
    json.dump([probe(a, b) for a, b in pairs], sys.stdout, ensure_ascii=False, indent=1)
