// POST /api/auth/login { nickname, password }
const L = require("../_lib");

module.exports = L.handler({
  async POST(req, res, { nickname, password }) {
    if (!L.validNick(nickname) || typeof password !== "string") throw new L.HttpError(400, "닉네임과 비밀번호를 확인해 주세요");
    await L.rateLimit(`login:${L.clientIp(req)}`, 30, 600);
    const key = L.nickKey(nickname);
    // 같은 닉네임 5회 연속 실패 시 5분 잠금
    const fails = +(await L.redis("GET", `fail:${key}`)) || 0;
    if (fails >= 5) throw new L.HttpError(423, "로그인을 5번 실패해서 5분 동안 잠겼어요");

    const raw = await L.redis("GET", `user:${key}`);
    const user = raw && JSON.parse(raw);
    if (!user || !L.checkPassword(password, user.salt, user.hash)) {
      await L.redis("INCR", `fail:${key}`);
      await L.redis("EXPIRE", `fail:${key}`, 300);
      throw new L.HttpError(401, "닉네임 또는 비밀번호가 맞지 않아요");
    }
    await L.redis("DEL", `fail:${key}`);
    L.setSession(res, user);
    res.status(200).json({ user: L.publicUser(user) });
  },
});
