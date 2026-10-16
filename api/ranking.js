// 거리 랭킹 (로그인한 사용자만, 모든 가입자 대상)
// GET /api/ranking?period=day|week|month → { period, rows: [{rank, nickname, km, mine}], me: {rank, km} | null }
const L = require("./_lib");

const TOP = 50;

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.requireUser(req);
    const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const period = ["day", "week", "month"].includes(q.period) ? q.period : "week";
    const key = L.rankKeys(L.todayKst())[period];
    const [flat, myScore, myIdx] = await L.pipeline([["ZREVRANGE", key, 0, TOP - 1, "WITHSCORES"], ["ZSCORE", key, user.nickname], ["ZREVRANK", key, user.nickname]]);
    const rows = [];
    for (let i = 0; i < (flat || []).length; i += 2) {
      const meters = +flat[i + 1]; if (meters <= 0) continue;
      const rank = rows.length && rows[rows.length - 1].meters === meters ? rows[rows.length - 1].rank : rows.length + 1;   // 동점은 같은 순위
      rows.push({ rank, nickname: flat[i], meters });
    }
    let me = null;
    if (myScore != null && +myScore > 0) {
      const hit = rows.find(r => r.nickname === user.nickname);
      me = { rank: hit ? hit.rank : myIdx + 1, km: Math.round(+myScore) / 1000 };
    }
    res.status(200).json({ period, me, rows: rows.map(r => ({ rank: r.rank, nickname: r.nickname, km: Math.round(r.meters) / 1000, mine: r.nickname === user.nickname })) });
  },
});
