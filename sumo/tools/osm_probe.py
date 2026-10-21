#!/usr/bin/env python3
"""Сбор фактов об одном перекрёстке из OpenStreetMap (Overpass API).

    python sumo/tools/osm_probe.py "Чуй проспект" "проспект Манаса" > probe.json
    python sumo/tools/osm_probe.py --restrictions 42.877856 74.562291 > restrictions.json

Ищет узлы, общие для двух улиц, и выводит линии, проходящие через них (теги lanes, oneway,
turn:lanes, maxspeed, начальная геометрия), а также светофоры в радиусе 60 м.
С ключом --restrictions выводит запреты и предписания поворотов (отношения type=restriction),
у которых узел «via» лежит в заданном радиусе от точки.
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
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
BBOX = "42.83,74.54,42.90,74.68"
UA = "SmartFlowAI-osm-probe/1.0 (https://github.com/AidarPamirov/smartflow-ai)"
TAGS = ("highway", "name", "name:ru", "oneway", "lanes", "lanes:forward", "lanes:backward", "turn:lanes",
        "turn:lanes:forward", "turn:lanes:backward", "maxspeed", "junction", "dual_carriageway")


def overpass(q: str) -> dict:
    import time
    err = []
    for url in ENDPOINTS * 2:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            err.append(f"{url}: {e}")
            time.sleep(5)
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
    # имя ищется и в name, и в name:ru (в Бишкеке name часто на кыргызском)
    q = f"""[out:json][timeout:90];
way[highway][~"^name(:ru)?$"~"^{street_a}$"]({BBOX})->.a;
way[highway][~"^name(:ru)?$"~"^{street_b}$"]({BBOX})->.b;
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


def restrictions(lat: float, lon: float, radius: float = 80.0) -> dict:
    q = f"""[out:json][timeout:90];
(node(around:{radius},{lat},{lon}); way(around:{radius},{lat},{lon})[highway];)->.near;
(relation(bn.near)[type~"^restriction"]; relation(bw.near)[type~"^restriction"];)->.r;
.r out body;
(way(r.r); node(r.r);)->.m;
.m out tags center;"""
    data = overpass(q)
    c = {"lat": lat, "lon": lon}
    el = {(e["type"], e["id"]): e for e in data["elements"]}

    def desc(m):
        e = el.get((m["type"], m["ref"]), {})
        t = e.get("tags", {})
        pos = e.get("center") or ({"lat": e["lat"], "lon": e["lon"]} if "lat" in e else None)
        return {"type": m["type"], "id": m["ref"], "name": t.get("name:ru") or t.get("name"), "highway": t.get("highway"),
                "dist_m": round(dist(c, pos), 1) if pos else None}

    out = []
    for r in (e for e in data["elements"] if e["type"] == "relation"):
        mem = {"from": [], "via": [], "to": []}
        for m in r.get("members", []):
            if m.get("role") in mem:
                mem[m["role"]].append(desc(m))
        via_d = [v["dist_m"] for v in mem["via"] if v["dist_m"] is not None]
        out.append({"id": r["id"], "tags": r.get("tags", {}), **mem, "via_within_radius": bool(via_d) and min(via_d) <= radius})
    return {
        "center": c, "radius_m": radius, "osm_base": data.get("osm3s", {}).get("timestamp_osm_base"),
        "restrictions_at_intersection": [r for r in out if r["via_within_radius"]],
        "restrictions_nearby_other": [r for r in out if not r["via_within_radius"]],
        "attribution": "© OpenStreetMap contributors, ODbL",
    }


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--restrictions":
        json.dump(restrictions(float(sys.argv[2]), float(sys.argv[3])), sys.stdout, ensure_ascii=False, indent=1)
        raise SystemExit
    pairs = [sys.argv[1:3]] if len(sys.argv) >= 3 else [
        ["Чуй проспект", "улица Жусупа Абдрахманова"],
        ["Чуй проспект", "проспект Чынгыза Айтматова"],
        ["Чуй проспект", "улица Раззакова"],
        ["Чуй проспект", "улица Манаса"],
    ]
    json.dump([probe(a, b) for a, b in pairs], sys.stdout, ensure_ascii=False, indent=1)
