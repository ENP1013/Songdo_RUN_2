// GET /api/me → 로그인한 사용자 / PATCH /api/me { weightKg }
const L = require("./_lib");

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.requireUser(req);
    res.status(200).json({ user: L.publicUser(user) });
  },
  async PATCH(req, res, { weightKg }) {
    const user = await L.requireUser(req);
    if (!L.validWeight(weightKg)) throw new L.HttpError(400, "체중은 30~150 kg 사이로 입력해 주세요");
    user.weightKg = weightKg === "" || weightKg == null ? null : Math.round(+weightKg);
    await L.redis("SET", `user:${L.nickKey(user.nickname)}`, JSON.stringify(user));
    res.status(200).json({ user: L.publicUser(user) });
  },
});
