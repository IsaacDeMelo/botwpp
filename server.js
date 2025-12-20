// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const routes = require("./routes");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);

const PORT = process.env.PORT || 3006;

app.listen(PORT, () => {
  console.log(`🔥 API rodando na porta ${PORT}`);
});
