// src/middleware/authGuard.js
export function authGuard() {
  const VALID_TOKEN = process.env.AUTH_TOKEN;

  if (!VALID_TOKEN) {
    const err = new Error("AUTH_TOKEN_NOT_DEFINED");
    err.statusCode = 500;
    throw err;
  }

  return async function (request) {
    const authHeader =
      request.headers.authorization ||
      request.headers["x-auth-token"];

    let token = authHeader;

    if (typeof token === "string" && token.startsWith("Bearer ")) {
      token = token.slice(7);
    }

    if (!token || token !== VALID_TOKEN) {
      const err = new Error("UNAUTHORIZED");
      err.statusCode = 401;
      throw err;
    }
  };
}
