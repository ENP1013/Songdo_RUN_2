"""OSM 원본(data/osm_raw.json) → 앱이 쓰는 송도 지도·보행망 데이터(data/songdo.json).

- 도로: 보행 가능 도로는 경로 탐색 그래프로, 자동차 전용 도로는 그리기만
- 공원·물: 폴리곤 링, 물길·해안선: 선
- 경계: 송도1~5동 행정동 경계
좌표는 정수로 압축: y = round(lat*1e5) - LAT0, x = round(lon*1e5) - LON0
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "osm_raw.json")
OUT = os.path.join(HERE, "..", "data", "songdo.json")
LAT0, LON0 = 3730000, 12655000

FOOT = {"footway", "path", "pedestrian", "steps", "cycleway", "corridor", "track", "bridleway"}
LOCAL = {"service", "residential", "unclassified", "living_street", "road"}
MAJOR = {"tertiary", "secondary", "primary", "tertiary_link", "secondary_link", "primary_link"}
CAR_ONLY = {"motorway", "motorway_link", "trunk", "trunk_link"}

def enc(lat, lon):
    return round(lat * 1e5) - LAT0, round(lon * 1e5) - LON0

def perp_m(p, a, b):
    ky, kx = 1.1057, 1.1132 * math.cos(math.radians(37.39))  # 1e-5도 → m
    ax, ay, bx, by, px, py = a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky, p[1] * kx, p[0] * ky
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy)
    if L == 0: return math.hypot(px - ax, py - ay)
    return abs(dy * px - dx * py + bx * ay - by * ax) / L

def dp(pts, eps, keep=None):
    """Douglas-Peucker. keep: 반드시 남길 인덱스 집합(교차점)."""
    if len(pts) < 3: return list(range(len(pts)))
    keep = keep or set()
    out = {0, len(pts) - 1} | {i for i in keep if 0 <= i < len(pts)}
    anchors = sorted(out)
    stack = list(zip(anchors, anchors[1:]))
    while stack:
        i, j = stack.pop()
        if j - i < 2: continue
        best, bi = -1, -1
        for k in range(i + 1, j):
            d = perp_m(pts[k], pts[i], pts[j])
            if d > best: best, bi = d, k
        if best > eps:
            out.add(bi); stack += [(i, bi), (bi, j)]
    return sorted(out)

def assemble(segs):
    """관계의 outer 선분들을 닫힌 링으로 이어 붙임."""
    segs = [list(s) for s in segs if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]
                elif s[-1] == cur[-1]: cur += s[::-1][1:]
                elif s[-1] == cur[0]: cur = s + cur[1:]
                elif s[0] == cur[0]: cur = s[::-1] + cur[1:]
                else: continue
                segs.pop(i); changed = True; break
        if len(cur) >= 4: rings.append(cur)
    return rings

def ring_out(ring, eps=3):
    pts = [enc(lat, lon) for lat, lon in ring]
    idx = dp(pts, eps)
    flat = []
    for i in idx: flat += pts[i]
    return flat

r = json.load(open(RAW, encoding="utf-8"))
els = r["elements"]

# ---------- 도로 / 보행 그래프 ----------
use = {}
walk_ways = []
for e in els:
    if e["type"] != "way": continue
    t = e.get("tags", {})
    hw = t.get("highway")
    if not hw or hw in ("construction", "proposed", "elevator", "platform", "bus_stop"): continue
    if t.get("area") == "yes": continue
    private = t.get("access") in ("private", "no") and t.get("foot") not in ("yes", "designated")
    if hw in CAR_ONLY or t.get("foot") == "no" or private:
        cls = 3
    elif hw in FOOT: cls = 0
    elif hw in LOCAL: cls = 1
    elif hw in MAJOR: cls = 2
    else: cls = 1
    if private and hw == "service": continue
    nodes, geom = e.get("nodes", []), e.get("geometry", [])
    if len(nodes) != len(geom) or len(nodes) < 2: continue
    walk_ways.append((cls, nodes, [(g["lat"], g["lon"]) for g in geom]))
    if cls < 3:
        for n in nodes: use[n] = use.get(n, 0) + 1
        use[nodes[0]] += 1; use[nodes[-1]] += 1

node_index, nodes_flat, ways_out = {}, [], []
for cls, nodes, geom in walk_ways:
    pts = [enc(*g) for g in geom]
    keep = {i for i, n in enumerate(nodes) if use.get(n, 0) > 1} if cls < 3 else set()
    idx = dp(pts, 2.0, keep)
    seq = [cls]
    for i in idx:
        n = nodes[i]
        if n not in node_index:
            node_index[n] = len(nodes_flat) // 2
            nodes_flat += pts[i]
        seq.append(node_index[n])
    ways_out.append(seq)

# ---------- 공원 · 물 · 경계 ----------
parks, water, water_lines, coast, boundary = [], [], [], [], []
peaks = []
for e in els:
    t = e.get("tags", {})
    if e["type"] == "node" and t.get("natural") == "peak":
        peaks.append({"name": t.get("name", ""), "at": [e["lat"], e["lon"]], "ele": t.get("ele")})
        continue
    if e["type"] == "way":
        g = [(p["lat"], p["lon"]) for p in e.get("geometry", [])]
        if len(g) < 2: continue
        closed = g[0] == g[-1] and len(g) >= 4
        if t.get("leisure") == "park" and closed:
            parks.append({"name": t.get("name", ""), "rings": [ring_out(g)]})
        elif t.get("natural") == "water" and closed:
            water.append([ring_out(g)])
        elif t.get("natural") == "coastline":
            coast.append(ring_out(g, 5))
        elif t.get("waterway") in ("stream", "river", "canal", "drain", "ditch"):
            water_lines.append(ring_out(g, 3))
    elif e["type"] == "relation":
        outer = [[(p["lat"], p["lon"]) for p in m.get("geometry", [])] for m in e.get("members", [])
                 if m.get("type") == "way" and m.get("role") in ("outer", "") and "geometry" in m]
        rings = assemble(outer)
        if not rings: continue
        if t.get("leisure") == "park":
            parks.append({"name": t.get("name", ""), "rings": [ring_out(x) for x in rings]})
        elif t.get("natural") == "water":
            water.append([ring_out(x) for x in rings])
        elif t.get("boundary") == "administrative":
            boundary.append({"name": t.get("name", ""), "rings": [ring_out(x, 8) for x in rings]})

# 아주 작은 공원(둘레 150m 미만)은 비율 계산에만 의미가 없어 제외
def ring_len_m(flat):
    s = 0
    for i in range(0, len(flat) - 2, 2):
        dy = (flat[i + 2] - flat[i]) * 1.1057
        dx = (flat[i + 3] - flat[i + 1]) * 1.1132 * math.cos(math.radians(37.39))
        s += math.hypot(dx, dy)
    return s
parks = [p for p in parks if sum(ring_len_m(x) for x in p["rings"]) >= 150]

out = {
    "origin": [LAT0, LON0], "scale": 1e5,
    "nodes": nodes_flat, "ways": ways_out,
    "parks": parks, "water": water, "waterLines": water_lines, "coast": coast,
    "boundary": boundary, "peaks": peaks,
    "attribution": "© OpenStreetMap contributors (ODbL)",
}
s = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
open(OUT, "w", encoding="utf-8").write(s)
print(f"nodes {len(nodes_flat)//2}, ways {len(ways_out)} (walk {sum(1 for w in ways_out if w[0] < 3)}), "
      f"parks {len(parks)}, water {len(water)}, waterLines {len(water_lines)}, coast {len(coast)}, "
      f"boundary {[b['name'] for b in boundary]}, peaks {[p['name'] for p in peaks]}, size {len(s)//1024} KB")
