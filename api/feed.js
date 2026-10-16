// 커뮤니티 피드 (로그인한 사용자만)
// GET /api/feed?offset=0 → { posts: [{id, nickname, date, courseName, min, km, kcal, difficulty, pace, likes, liked, comments, mine}], next }
// POST /api/feed {id} → 좋아요 토글 { liked, likes }
const L = require("./_lib");

const PAGE = 20;
const ID = /^[0-9a-f-]{36}$/;

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.requireUser(req);
    const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const offset = Math.max(0, Math.min(1000, parseInt(q.offset, 10) || 0));
    const ids = await L.redis("LRANGE", "feed", offset, offset + PAGE - 1) || [];
    const out = await L.pipeline(ids.flatMap(id => [["GET", `post:${id}`], ["SCARD", `likes:${id}`], ["SISMEMBER", `likes:${id}`, user.id], ["LLEN", `comments:${id}`]]));
    const posts = [];
    ids.forEach((id, i) => {
      const [raw, likes, liked, comments] = out.slice(i * 4, i * 4 + 4);
      if (!raw) return;
      const p = JSON.parse(raw);
      posts.push({ id: p.id, nickname: p.nickname, date: p.date, courseName: p.courseName, min: p.min, km: p.km, kcal: p.kcal,
        difficulty: p.difficulty, pace: p.pace, likes: likes || 0, liked: !!liked, comments: comments || 0, mine: p.uid === user.id });
    });
    res.status(200).json({ posts, next: ids.length === PAGE ? offset + PAGE : null });
  },
  async POST(req, res, { id }) {
    const user = await L.requireUser(req);
    await L.rateLimit(`like:${user.id}`, 120, 600);
    if (!ID.test(String(id)) || !(await L.redis("EXISTS", `post:${id}`))) throw new L.HttpError(404, "게시물을 찾지 못했어요");
    const liked = !(await L.redis("SISMEMBER", `likes:${id}`, user.id));
    await L.redis(liked ? "SADD" : "SREM", `likes:${id}`, user.id);
    res.status(200).json({ liked, likes: await L.redis("SCARD", `likes:${id}`) });
  },
});
