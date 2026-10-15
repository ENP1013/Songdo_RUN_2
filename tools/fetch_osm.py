import json, urllib.request, urllib.parse, sys, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
BBOX = "37.352,126.595,37.425,126.700"
q = f"""[out:json][timeout:120];
(
 way["highway"]({BBOX});
 way["leisure"="park"]({BBOX});
 relation["leisure"="park"]({BBOX});
 way["natural"="water"]({BBOX});
 relation["natural"="water"]({BBOX});
 way["waterway"]({BBOX});
 way["natural"="coastline"]({BBOX});
 relation["boundary"="administrative"]["name"~"송도"]({BBOX});
 node["natural"="peak"]({BBOX});
);
out geom;"""
data = urllib.parse.urlencode({"data": q}).encode()
req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=data, headers={"User-Agent": "runwalk-demo/0.1"})
raw = urllib.request.urlopen(req, timeout=180).read()
open(os.path.join(OUT, "osm_raw.json"), "wb").write(raw)
r = json.loads(raw)
from collections import Counter
c = Counter()
for e in r["elements"]:
    t = e.get("tags", {})
    k = t.get("highway") and "hw:" + t["highway"] or t.get("leisure") or t.get("natural") or t.get("waterway") or t.get("boundary") or "?"
    c[e["type"] + ":" + k] += 1
print(len(raw) // 1024, "KB")
for k, v in c.most_common(): print(k, v)
for e in r["elements"]:
    t = e.get("tags", {})
    if t.get("boundary"): print("BOUNDARY", t.get("name"), t.get("admin_level"), e["id"])
