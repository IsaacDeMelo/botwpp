// auth.js
const AUTH_TOKEN = process.env.AUTH_TOKEN;

module.exports.authServer = (req, res, next) => {
  const token = req.headers.authorization;

  if (!AUTH_TOKEN) {
    return res.status(500).json({ error: "AUTH_TOKEN não configurado no servidor" });
  }

  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  next();
};
