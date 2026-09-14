import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { pool } from "./db.js";
import { providerInfo } from "./lib/llm.js";
import cases from "./routes/cases.js";
import accounts from "./routes/accounts.js";
import metrics from "./routes/metrics.js";
import registry from "./routes/registry.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));   // traced results can be chunky

app.get("/api/health", async (_req, res) => {
  let db = "down";
  try { await pool.query("SELECT 1"); db = "up"; }
  catch (e) { db = `down: ${e.message}`; }
  res.json({ ok: true, db, llm: providerInfo() });
});

app.use("/api/cases", cases);
app.use("/api/accounts", accounts);
app.use("/api/metrics", metrics);
app.use("/api/registry", registry);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "server error" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  const { provider, configured } = providerInfo();
  console.log(`\n  MuleNet API   http://localhost:${port}`);
  console.log(`  LLM provider  ${provider}${configured ? "" : "  (not configured - deterministic fallback in use)"}\n`);
});
