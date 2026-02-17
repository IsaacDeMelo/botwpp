// src/bailey/router.js
// Compat layer: delega para o router principal e evita duplicacao de rotas.
import routes from "../routes.js";
import { createBailey } from "./config.js";

export default async function baileyRouter(app) {
  const bailey = createBailey({
    authDir: "./auth",
    browserName: "ITSUKI-API"
  });

  return routes(app, { bailey });
}

