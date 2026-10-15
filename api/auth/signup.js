// POST /api/auth/signup { nickname, password, weightKg? }
const crypto = require("crypto");
const L = require("../_lib");

module.exports = L.handler({
  async POST(req, res, { nickname, password, weightKg }) {
    if (!L.validNick(nickname)) throw new L.HttpError(400, "닉네임은 한글·영문·숫자 2~12자로 정해 주세요");
    if (typeof password !== "string" || password.length < 4 || password.length > 100) throw new L.HttpError(400, "비밀번호는 4자 이상으로 정해 주세요");
    if (!L.validWeight(weightKg)) throw new L.HttpError(400, "체중은 30~150 kg 사이로 입력해 주세요");
    await L.rateLimit(`signup:${L.clientIp(req)}`, 10, 3600);

    const nick = nickname.normalize("NFC");
    const { salt, hash } = L.hashPassword(password);
    const user = { id: crypto.randomUUID(), nickname: nick, salt, hash,
      weightKg: weightKg === "" || weightKg == null ? null : Math.round(+weightKg), createdAt: new Date().toISOString() };
    // 닉네임 중복이면 저장하지 않음 (NX)
    const ok = await L.redis("SET", `user:${L.nickKey(nick)}`, JSON.stringify(user), "NX");
    if (ok !== "OK") throw new L.HttpError(409, "이미 쓰는 닉네임이에요");
    L.setSession(res, user);
    res.status(201).json({ user: L.publicUser(user) });
  },
});
