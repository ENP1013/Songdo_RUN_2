/* 송도 보행망 위에서 코스를 만드는 엔진 (브라우저·Node 공용, 외부 의존성 없음)
   - 데이터: tools/build_data.py 가 만든 songdo.json (OpenStreetMap)
   - 경로: A* 최단 보행 경로를 경유지마다 이어 붙임
   - 코스 후보: 원형 루프 / 공원 둘레 루프 / A→B 우회 / 봉재산 언덕 반복 → 목표 거리에 맞게 보정 후 점수로 선택 */
const Engine = (() => {
  const KY = 110570, KX = 111320 * Math.cos(37.39 * Math.PI / 180);   // m per degree (송도 위도 기준)
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * KX);
  const CELL = 0.001;  // 공간 격자 (~110 m)

  let lat, lon, off, adj, wgt, nodeGrid;
  let parks = [], waters = [], waterSegs, parkSegs, boundary = [], peaks = [], loaded = null;

  /* ---------- 로드 ---------- */
  function decodeFlat(flat, o, s) { const pts = []; for (let i = 0; i < flat.length; i += 2) pts.push([(flat[i] + o[0]) / s, (flat[i + 1] + o[1]) / s]); return pts; }
  function bboxOf(pts) { let s = 90, w = 180, n = -90, e = -180; for (const p of pts) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); } return [s, w, n, e]; }
  const key = (y, x) => `${Math.floor(y / CELL)},${Math.floor(x / CELL)}`;

  function segGrid(lines) {   // 선분을 지나는 격자칸에 등록 (근접 판정용)
    const g = new Map();
    lines.forEach((pts, li) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const steps = Math.max(1, Math.ceil(distM(a, b) / 50));
        const seen = new Set();
        for (let k = 0; k <= steps; k++) {
          const y = a[0] + (b[0] - a[0]) * k / steps, x = a[1] + (b[1] - a[1]) * k / steps;
          const kk = key(y, x); if (seen.has(kk)) continue; seen.add(kk);
          if (!g.has(kk)) g.set(kk, []); g.get(kk).push([li, a, b]);
        }
      }
    });
    return g;
  }

  function load(d) {
    const o = d.origin, s = d.scale, n = d.nodes.length / 2;
    lat = new Float64Array(n); lon = new Float64Array(n);
    for (let i = 0; i < n; i++) { lat[i] = (d.nodes[2 * i] + o[0]) / s; lon[i] = (d.nodes[2 * i + 1] + o[1]) / s; }
    // 인접 리스트 (CSR). 큰 도로는 비용 15% 가산해 보도·공원길을 약간 선호
    const deg = new Uint32Array(n), edges = [];
    const walkable = new Uint8Array(n);
    for (const w of d.ways) {
      if (w[0] === 3) continue;
      const mul = w[0] === 2 ? 1.15 : 1;
      for (let i = 2; i < w.length; i++) {
        const a = w[i - 1], b = w[i];
        const m = distM([lat[a], lon[a]], [lat[b], lon[b]]);
        edges.push(a, b, m, mul); deg[a]++; deg[b]++; walkable[a] = walkable[b] = 1;
      }
    }
    off = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
    adj = new Uint32Array(off[n]); wgt = new Float32Array(off[n] * 2);
    const pos = off.slice(0, n);
    for (let i = 0; i < edges.length; i += 4) {
      const [a, b, m, mul] = [edges[i], edges[i + 1], edges[i + 2], edges[i + 3]];
      adj[pos[a]] = b; wgt[2 * pos[a]] = m; wgt[2 * pos[a] + 1] = m * mul; pos[a]++;
      adj[pos[b]] = a; wgt[2 * pos[b]] = m; wgt[2 * pos[b] + 1] = m * mul; pos[b]++;
    }
    nodeGrid = new Map();
    for (let i = 0; i < n; i++) if (walkable[i]) { const k = key(lat[i], lon[i]); if (!nodeGrid.has(k)) nodeGrid.set(k, []); nodeGrid.get(k).push(i); }
    // 가장 큰 연결 요소만 사용 (고립된 조각에 스냅되는 것 방지)
    const comp = new Int32Array(n).fill(-1); let best = -1, bestSize = 0;
    for (let i = 0, c = 0; i < n; i++) {
      if (!walkable[i] || comp[i] >= 0) continue;
      let size = 0; const st = [i]; comp[i] = c;
      while (st.length) { const u = st.pop(); size++; for (let e = off[u]; e < off[u + 1]; e++) if (comp[adj[e]] < 0) { comp[adj[e]] = c; st.push(adj[e]); } }
      if (size > bestSize) { bestSize = size; best = c; } c++;
    }
    for (const [k, arr] of nodeGrid) { const f = arr.filter(i => comp[i] === best); if (f.length) nodeGrid.set(k, f); else nodeGrid.delete(k); }

    parks = d.parks.map(p => {
      const rings = p.rings.map(r => decodeFlat(r, o, s));
      const outer = rings.reduce((a, b) => (b.length > a.length ? b : a));
      let per = 0; for (let i = 1; i < outer.length; i++) per += distM(outer[i - 1], outer[i]);
      const c = outer.reduce((acc, q) => [acc[0] + q[0] / outer.length, acc[1] + q[1] / outer.length], [0, 0]);
      return { name: p.name, rings, outer, per, center: c, bbox: bboxOf(rings.flat()) };
    });
    waters = d.water.map(rs => { const rings = rs.map(r => decodeFlat(r, o, s)); return { rings, bbox: bboxOf(rings.flat()) }; });
    const waterLines = [...d.waterLines, ...d.coast].map(r => decodeFlat(r, o, s));
    waterSegs = segGrid([...waters.flatMap(w => w.rings), ...waterLines]);
    parkSegs = segGrid(parks.map(p => p.outer));
    boundary = d.boundary.map(b => ({ name: b.name, rings: b.rings.map(r => decodeFlat(r, o, s)) }));
    peaks = d.peaks;
    loaded = { parks, waters, waterLines, boundary, peaks };
    return loaded;
  }

  /* ---------- 기하 ---------- */
  function inRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inBox = (p, b, padDeg = 0) => p[0] >= b[0] - padDeg && p[0] <= b[2] + padDeg && p[1] >= b[1] - padDeg && p[1] <= b[3] + padDeg;
  function segDistM(p, a, b) {
    const ax = a[1] * KX, ay = a[0] * KY, bx = b[1] * KX, by = b[0] * KY, px = p[1] * KX, py = p[0] * KY;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function nearSegs(p, grid, m) {   // m 미터 안의 선분이 있으면 그 선분 소속 인덱스 반환
    const cy = Math.floor(p[0] / CELL), cx = Math.floor(p[1] / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = grid.get(`${cy + dy},${cx + dx}`); if (!arr) continue;
      for (const [li, a, b] of arr) if (segDistM(p, a, b) <= m) return li;
    }
    return -1;
  }
  const inSongdo = p => boundary.some(b => b.rings.some(r => inRing(p, r)));
  function parkAt(p, nearM = 30) {
    for (let i = 0; i < parks.length; i++) { const k = parks[i]; if (inBox(p, k.bbox) && k.rings.some(r => inRing(p, r))) return i; }
    return nearSegs(p, parkSegs, nearM);
  }
  function waterNear(p, nearM = 40) {
    for (const w of waters) if (inBox(p, w.bbox) && w.rings.some(r => inRing(p, r))) return true;
    return nearSegs(p, waterSegs, nearM) >= 0;
  }

  /* ---------- 경로 탐색 ---------- */
  function nearestNode(p, maxM = 400) {
    const cy = Math.floor(p[0] / CELL), cx = Math.floor(p[1] / CELL);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 4 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
        const arr = nodeGrid.get(`${cy + dy},${cx + dx}`); if (!arr) continue;
        for (const i of arr) { const d = distM(p, [lat[i], lon[i]]); if (d < bd) { bd = d; best = i; } }
      }
      if (best >= 0 && r === 0) { r = 1; /* 한 칸 더 확인 */ for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const arr = nodeGrid.get(`${cy + dy},${cx + dx}`); if (arr) for (const i of arr) { const d = distM(p, [lat[i], lon[i]]); if (d < bd) { bd = d; best = i; } } } }
    }
    return bd <= maxM ? best : -1;
  }

  let gScore, from, stamp, closedStamp, run = 0;
  const memo = new Map();
  function astar(s, t) {
    if (s === t) return { nodes: [s], m: 0 };
    const mk = s < t ? `${s}-${t}` : `${t}-${s}`;
    const hit = memo.get(mk);
    if (hit) return hit.s === s ? hit.r : { nodes: hit.r.nodes.slice().reverse(), m: hit.r.m };
    const n = lat.length;
    if (!gScore) { gScore = new Float64Array(n); from = new Int32Array(n); stamp = new Uint32Array(n); closedStamp = new Uint32Array(n); }
    run++;
    const tp = [lat[t], lon[t]];
    const h = i => distM([lat[i], lon[i]], tp);
    // 이진 힙
    const heap = [], push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    stamp[s] = run; gScore[s] = 0; from[s] = -1; push(h(s), s);
    let found = false;
    while (heap.length) {
      const [, u] = pop();
      if (closedStamp[u] === run) continue; closedStamp[u] = run;
      if (u === t) { found = true; break; }
      for (let e = off[u]; e < off[u + 1]; e++) {
        const v = adj[e], g = gScore[u] + wgt[2 * e + 1];
        if (stamp[v] !== run || g < gScore[v]) { stamp[v] = run; gScore[v] = g; from[v] = u; push(g + h(v), v); }
      }
    }
    if (!found) return null;
    const nodes = []; for (let u = t; u !== -1; u = from[u]) nodes.push(u);
    nodes.reverse();
    let m = 0; for (let i = 1; i < nodes.length; i++) m += distM([lat[nodes[i - 1]], lon[nodes[i - 1]]], [lat[nodes[i]], lon[nodes[i]]]);
    const r = { nodes, m };
    if (memo.size > 4000) memo.clear();
    memo.set(mk, { s, r });
    return r;
  }
  function chain(ids) {   // 경유지 노드들을 순서대로 이음
    let nodes = [ids[0]], m = 0;
    for (let i = 1; i < ids.length; i++) {
      const r = astar(ids[i - 1], ids[i]); if (!r) return null;
      nodes = nodes.concat(r.nodes.slice(1)); m += r.m;
    }
    return { nodes, m };
  }
  // 30 m도 안 되는 막다른 가지에 들어갔다 바로 나오는 A→X→A는 걷는 의미가 없고 갈림길만 헷갈리게 하므로 A로 줄인다
  const toPath = nodes => {
    const out = [];
    for (const i of nodes) {
      out.push(i);
      const n = out.length;
      if (n >= 3 && out[n - 1] === out[n - 3] && distM([lat[out[n - 2]], lon[out[n - 2]]], [lat[i], lon[i]]) < 30) out.length = n - 2;
    }
    return out.map(i => [lat[i], lon[i]]);
  };

  /* ---------- 코스 분석 ---------- */
  function analyze(path) {
    let total = 0, parkM = 0, waterM = 0; const byPark = new Map();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], len = distM(a, b);
      const steps = Math.max(1, Math.round(len / 20));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], part = len / steps;
        const pi = parkAt(p);
        if (pi >= 0) { parkM += part; const nm = parks[pi].name; if (nm) byPark.set(nm, (byPark.get(nm) || 0) + part); }
        if (waterNear(p)) waterM += part;
      }
      total += len;
    }
    const names = [...byPark].filter(([n, m]) => m >= 150 && /[가-힣]/.test(n)).sort((x, y) => y[1] - x[1]).map(([n]) => n.replace(/^송도\s?/, ""));
    return { m: total, park: total ? parkM / total : 0, water: total ? waterM / total : 0, parkNames: [...new Set(names)] };
  }
  function kmMarks(path) {
    const out = []; let acc = 0, next = 1000;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], len = distM(a, b);
      while (acc + len >= next) { const t = (next - acc) / len; out.push({ km: next / 1000, at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }); next += 1000; }
      acc += len;
    }
    return out;
  }

  /* ---------- 후보 생성 ---------- */
  const offset = (p, bearingDeg, m) => { const r = bearingDeg * Math.PI / 180; return [p[0] + Math.cos(r) * m / KY, p[1] + Math.sin(r) * m / KX]; };
  const DIRS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  const dirName = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  const bearing = (a, b) => (Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180 / Math.PI + 360) % 360;

  function snapIn(p) { if (!inSongdo(p)) return -1; return nearestNode(p, 250); }

  // 원형 루프: A가 원 위에 오도록, θ 방향으로 반지름 r만큼 떨어진 중심에 경유지 3개
  function circleRoute(sN, eN, A, Dm, theta, k) {
    const r = k * Dm / (2 * Math.PI);
    const c = offset(A, theta, r);
    const ids = [sN];
    for (const a of [theta + 180 + 90, theta, theta + 180 - 90]) {   // A의 반대편 돌기
      const w = snapIn(offset(c, a, r)); if (w < 0) return null; ids.push(w);
    }
    ids.push(eN);
    const ch = chain(ids); if (!ch) return null;
    return { ...ch, kind: "circle", theta, k };
  }
  function fitCircle(sN, eN, A, Dm, theta) {
    let k = 0.8, best = null;
    for (let it = 0; it < 3; it++) {
      const c = circleRoute(sN, eN, A, Dm, theta, k); if (!c) return best;
      if (!best || Math.abs(c.m - Dm) < Math.abs(best.m - Dm)) best = c;
      if (Math.abs(c.m - Dm) / Dm <= 0.05) break;
      k *= Dm / c.m;
    }
    return best;
  }

  // 공원 둘레 루프: 입구 → 둘레 3점 순환 × n바퀴 → 도착지
  function parkRoute(sN, eN, A, Dm, park) {
    const ring = park.outer, cum = [0];
    for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + distM(ring[i - 1], ring[i]));
    const per = cum[cum.length - 1];
    const at = f => { const L = ((f % 1) + 1) % 1 * per; let i = 1; while (i < cum.length - 1 && cum[i] < L) i++; const t = (L - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return [ring[i - 1][0] + (ring[i][0] - ring[i - 1][0]) * t, ring[i - 1][1] + (ring[i][1] - ring[i - 1][1]) * t]; };
    let f0 = 0, bd = Infinity;
    for (let f = 0; f < 1; f += 0.02) { const d = distM(at(f), A); if (d < bd) { bd = d; f0 = f; } }
    const w = [f0, f0 + 1 / 3, f0 + 2 / 3].map(f => nearestNode(at(f), 120));
    if (w.some(x => x < 0) || new Set(w).size < 3) return null;
    const circ = chain([w[0], w[1], w[2], w[0]]); if (!circ || circ.m < 300) return null;
    const acc = astar(sN, w[0]), egr = astar(w[0], eN); if (!acc || !egr) return null;
    const laps = Math.max(1, Math.round((Dm - acc.m - egr.m) / circ.m));
    let nodes = acc.nodes.slice();
    for (let l = 0; l < laps; l++) nodes = nodes.concat(circ.nodes.slice(1));
    nodes = nodes.concat(egr.nodes.slice(1));
    return { nodes, m: acc.m + laps * circ.m + egr.m, kind: "park", parkName: park.name.replace(/^송도\s?/, ""), laps, lapM: circ.m,
             uniqueM: acc.m + circ.m };   // 반복 전 구간(진입 + 첫 바퀴)
  }

  // A→B 우회: AB 선분 옆으로 h만큼 벌린 경유지 2개
  function detourRoute(sN, eN, A, B, Dm, side) {
    const d = distM(A, B), brg = bearing(A, B);
    let h = Math.sqrt(Math.max(((Dm - d / 2) / 2) ** 2 - (d / 4) ** 2, 100 ** 2)) * 0.75, best = null;
    for (let it = 0; it < 3; it++) {
      const p1 = offset(offset(A, brg, d * 0.25), brg + 90 * side, h), p2 = offset(offset(A, brg, d * 0.75), brg + 90 * side, h);
      const w1 = snapIn(p1), w2 = snapIn(p2); if (w1 < 0 || w2 < 0) break;
      const ch = chain([sN, w1, w2, eN]); if (!ch) break;
      const c = { ...ch, kind: "detour", side };
      if (!best || Math.abs(c.m - Dm) < Math.abs(best.m - Dm)) best = c;
      if (Math.abs(c.m - Dm) / Dm <= 0.05) break;
      h *= Math.max(0.3, Math.min(2.5, 1 + (Dm - c.m) / Math.max(c.m - d * 0.9, 200)));
    }
    return best;
  }

  // 봉재산 언덕 반복: 산 아래 지점 ↔ 정상 왕복 × n회
  function hillRoute(sN, eN, Dm) {
    const pk = peaks.find(p => p.name === "봉재산"); if (!pk) return null;
    const top = nearestNode(pk.at, 200); if (top < 0) return null;
    const up = astar(sN, top); if (!up) return null;
    // 정상에서 경로를 거슬러 400 m 아래를 반복 기점으로
    let acc = 0, baseIdx = up.nodes.length - 1;
    for (let i = up.nodes.length - 1; i > 0 && acc < 400; i--) { acc += distM([lat[up.nodes[i]], lon[up.nodes[i]]], [lat[up.nodes[i - 1]], lon[up.nodes[i - 1]]]); baseIdx = i - 1; }
    const base = up.nodes[baseIdx];
    const toBase = astar(sN, base), rep = chain([base, top, base]), back = astar(base, eN);
    if (!toBase || !rep || !back || rep.m < 200) return null;
    const reps = Math.max(1, Math.round((Dm - toBase.m - back.m) / rep.m));
    let nodes = toBase.nodes.slice();
    for (let l = 0; l < reps; l++) nodes = nodes.concat(rep.nodes.slice(1));
    nodes = nodes.concat(back.nodes.slice(1));
    const ele = parseFloat(pk.ele) || 104;
    return { nodes, m: toBase.m + reps * rep.m + back.m, kind: "hill", reps, elev: Math.round(reps * Math.min(ele * 0.6, 70)),
             uniqueM: toBase.m + rep.m, turn: [lat[top], lon[top]], turnLabel: "정상 반환" };
  }

  /* ---------- 공개 API ---------- */
  const WATER_MIN = 0.1;   // 물가로 고른 코스의 물가 구간이 10% 미만이면 공원 기준으로 다시 고른다
  const SCENE_W = 100;   // 선호 풍경 가중치 (200이면 물가 코스 거리 오차가 평균 12%까지 벌어짐)
  // prefs: { scenery: "park" | "water" | "city" | "mountain" | "" (상관없음), difficulty }
  function plan(A, B, Dm, prefs, avoid = new Set()) {
    const sN = nearestNode(A, 400), eN = nearestNode(B, 400);
    if (sN < 0 || eN < 0) return { error: "far" };
    const same = distM(A, B) < 30;
    const cands = [];
    const add = c => { if (c && c.nodes.length > 1) cands.push(c); };

    if (!same) {
      const d0 = astar(sN, eN);
      if (!d0) return { error: "noroute" };
      if (d0.m > Dm * 1.1) {
        const path = toPath(d0.nodes);
        return { infeasible: true, path, m: d0.m, kind: "direct", ...analyze(path), kmMarks: kmMarks(path) };
      }
      add(detourRoute(sN, eN, A, B, Dm, 1));
      add(detourRoute(sN, eN, A, B, Dm, -1));
    }
    // 원형 루프 6방향: 한 번씩 만들어 보고 거리 오차가 작은 3개만 보정
    const rough = [];
    for (let th = 0; th < 360; th += 60) { const c = circleRoute(sN, eN, A, Dm, th, 0.8); if (c) rough.push(c); }
    rough.sort((x, y) => Math.abs(x.m - Dm) - Math.abs(y.m - Dm));
    for (const c of rough.slice(0, 3)) add(fitCircle(sN, eN, A, Dm, c.theta));
    // 왕복: 8방향으로 절반 거리만큼 갔다가 돌아오기 (짧은 시간·좁은 곳 대비)
    for (let th = 0; th < 360; th += 45) {
      const w = snapIn(offset(A, th, Dm * 0.4)); if (w < 0) continue;
      const go = chain([sN, w, eN]), leg = astar(sN, w);
      if (go && leg) add({ ...go, kind: "out", theta: th, uniqueM: leg.m, turn: [lat[w], lon[w]], turnLabel: "반환" });
    }
    // 공원 둘레: 출발지에서 가까운 큰 공원
    const near = parks.filter(p => /[가-힣]/.test(p.name) && p.per >= 500 && distM(p.center, A) <= Dm * 0.4)
      .sort((x, y) => distM(x.center, A) - distM(y.center, A)).slice(0, 5);
    for (const p of near) add(parkRoute(sN, eN, A, Dm, p));
    if (prefs.difficulty === "hill" || prefs.scenery === "mountain") add(hillRoute(sN, eN, Dm));

    if (!cands.length) return { error: "nocandidate" };
    // 고른 풍경의 구간 비율을 후보 중 최고값에 견줘 0~1로 맞춘 뒤 SCENE_W를 곱한다.
    // 물가처럼 비율이 원래 낮은 풍경도 효과가 나도록 상대값을 쓰고, 최고값이 25% 미만이면 25%로 나눠 미미한 차이는 키우지 않는다.
    const analyzed = cands.map(c => { const path = toPath(c.nodes); return { c, path, an: analyze(path) }; });
    const rank = scene => {
      const sceneRatio = an => scene === "park" ? an.park : scene === "water" ? an.water
        : scene === "city" ? 1 - Math.max(an.park, an.water) : 0;
      const bestRatio = Math.max(0.25, ...analyzed.map(x => sceneRatio(x.an)));
      return analyzed.map(({ c, path, an }) => {
        const err = Math.abs(an.m - Dm) / Dm;
        let s = -err * 120 - (err > 0.1 ? 40 : 0);
        s += SCENE_W * sceneRatio(an) / bestRatio;
        if (c.kind === "hill") s += prefs.difficulty === "hill" ? 60 : prefs.scenery === "mountain" ? 30 : -40;
        if (c.kind === "park" && c.laps > 3) s -= (c.laps - 3) * 6;
        const id = c.kind === "park" ? "park:" + c.parkName : c.kind === "hill" ? "hill" : c.kind + ":" + (c.theta ?? c.side);
        if (avoid.has(id)) s -= 35;
        if (an.m < Dm * 0.5) s -= 200;   // 경로가 뭉개진 후보
        return { ...c, id, path, ...an, score: s, err };
      }).sort((x, y) => y.score - x.score);
    };
    let scene = prefs.scenery, best = rank(scene)[0];
    if (scene === "water" && best.water < WATER_MIN) { scene = "park"; best = rank(scene)[0]; }   // 물가가 거의 없는 코스면 공원 기준으로
    best.kmMarks = kmMarks(best.path);
    best.name = courseName(best, A, B, same);
    if (scene !== prefs.scenery) best.sceneFallback = scene;
    return best;
  }

  /* ---------- 동물 얼굴 코스 (이벤트) ---------- */
  // 얼굴 윤곽(x 오른쪽, y 위쪽, 폭 약 1)을 출발지에 맞춰 놓고 일정 간격으로 경유지를 찍어 보행로로 잇는다.
  // 경유지 간격(140·100 m)과 출발지에 맞출 꼭짓점·회전(±15°)·크기를 바꿔 보며 기준을 통과한 경로 중 윤곽과 가장 비슷한 것을 고른다 (없으면 null)
  const SHAPES = {
    cat: [[0, -0.5], [0.35, -0.42], [0.5, -0.1], [0.5, 0.25], [0.46, 0.72], [0.2, 0.42], [-0.2, 0.42], [-0.46, 0.72], [-0.5, 0.25], [-0.5, -0.1], [-0.35, -0.42], [0, -0.5]],
    heart: [[0, -0.55], [0.3, -0.25], [0.5, 0.02], [0.56, 0.28], [0.46, 0.48], [0.26, 0.55], [0.1, 0.46], [0, 0.32], [-0.1, 0.46], [-0.26, 0.55], [-0.46, 0.48], [-0.56, 0.28], [-0.5, 0.02], [-0.3, -0.25], [0, -0.55]],
  };
  const ANIMAL_OK = { dev: 0.04, err: 0.1, dup: 0.12 };   // 윤곽 편차(얼굴 폭 대비)·거리 오차·되돌아가는 구간 비율 상한
  function animalRoute(A, Dm, shape = "cat") {
    const T = SHAPES[shape], sN = nearestNode(A, 400);
    if (!T || sN < 0) return null;
    const xy = p => [(p[1] - A[1]) * KX, (p[0] - A[0]) * KY], ll = ([x, y]) => [A[0] + y / KY, A[1] + x / KX];
    const fill = (pts, step) => {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      }
      return out;
    };
    const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    const lineD = (p, L) => { let m = Infinity; for (let i = 1; i < L.length; i++) m = Math.min(m, segD(p, L[i - 1], L[i])); return m; };
    const per = T.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - T[i][0], p[1] - T[i][1]), 0);
    let best = null;
    for (const step of [140, 100]) for (let a = 0; a < T.length - 1; a++) for (const rot of [-15, 0, 15]) for (const k of [0.62, 0.72, 0.82]) {
      const s = Dm * k / per, r = rot * Math.PI / 180;
      const pts = T.slice(a, -1).concat(T.slice(0, a + 1)).map(([x, y]) => {   // a번 꼭짓점이 출발지에 오도록
        const X = (x - T[a][0]) * s, Y = (y - T[a][1]) * s; return [X * Math.cos(r) - Y * Math.sin(r), X * Math.sin(r) + Y * Math.cos(r)];
      });
      const way = fill(pts, step), ids = [sN];
      let ok = true;
      for (const p of way.slice(1, -1)) { const n = snapIn(ll(p)); if (n < 0) { ok = false; break; } if (n !== ids[ids.length - 1]) ids.push(n); }
      if (!ok) continue;
      ids.push(sN);
      const ch = chain(ids); if (!ch) continue;
      const path = toPath(ch.nodes), an = analyze(path), R = path.map(xy), Tm = fill(pts, 25);
      const dev = (Tm.reduce((t, p) => t + lineD(p, R), 0) / Tm.length + R.reduce((t, p) => t + lineD(p, pts), 0) / R.length) / 2 / s;
      const keys = new Set(); let dup = 0;
      for (let i = 1; i < path.length; i++) { const kk = [path[i - 1], path[i]].map(q => q.join()).sort().join("|"); if (keys.has(kk)) dup++; keys.add(kk); }
      const err = Math.abs(an.m - Dm) / Dm; dup /= Math.max(1, path.length - 1);
      const score = dev + err * 0.5 + dup * 0.5;
      const pass = dev <= ANIMAL_OK.dev && err <= ANIMAL_OK.err && dup <= ANIMAL_OK.dup;
      if (pass && (!best || score < best.score)) best = { path, ...an, dev, err, dup, score, outline: pts.map(ll) };
    }
    if (!best) return null;
    return { ...best, kind: "animal", shape, id: "animal:" + shape, name: { cat: "고양이 얼굴 코스", heart: "하트 코스" }[shape], kmMarks: kmMarks(best.path) };
  }

  function courseName(c, A, B, same) {
    if (c.kind === "park") return `${c.parkName} 둘레 ${c.laps}바퀴`;
    if (c.kind === "out") return `${c.parkNames[0] ? c.parkNames[0] + " 방향" : dirName(c.theta) + "쪽"} 왕복`;
    if (c.kind === "hill") return `봉재산 언덕 반복 ${c.reps}회`;
    const via = c.parkNames[0];
    if (c.kind === "detour") return via ? `${via} 경유 우회 코스` : `${c.side > 0 ? "왼쪽" : "오른쪽"}으로 도는 우회 코스`;
    const dir = dirName(c.theta);
    return via ? `${via} 경유 ${dir}쪽 루프` : `${dir}쪽 동네 한 바퀴`;
  }

  return { load, plan, animalRoute, inSongdo, nearestNode, distM, get data() { return loaded; } };
})();
if (typeof module !== "undefined") module.exports = Engine;
