// POST /api/auth/logout
const L = require("../_lib");

module.exports = L.handler({
  async POST(req, res) {
    L.clearSession(res);
    res.status(200).json({ ok: true });
  },
});
