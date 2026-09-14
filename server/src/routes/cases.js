import { Router } from "express";
import { q, one } from "../db.js";
import { runCase } from "../algo/pipeline.js";
import { chat, parseJson } from "../lib/llm.js";
import {
  SYSTEM_EXPLAIN, SYSTEM_INTAKE, SYSTEM_QUERY,
  explainPrompt, intakePrompt, queryPrompt
} from "../lib/prompts.js";

const r = Router();

/** Demo helper: the injected rings, so the UI has something to fire. */
r.get("/rings", async (_req, res) => {
  const rows = await q(
    `SELECT rg.id, rg.label, rg.victim_id, rg.amount, rg.fraud_ts, rg.depth,
            a.acct_no, a.bank_code, a.city,
            (SELECT COUNT(*) FROM ring_members m WHERE m.ring_id = rg.id) AS mules
       FROM rings rg
       JOIN accounts a ON a.id = rg.victim_id
      ORDER BY rg.fraud_ts DESC`
  );
  res.json(rows);
});

/** Run the full pipeline. This is the heart of the demo. */
r.post("/trace", async (req, res) => {
  const {
    victim_id, fraud_ts, amount,
    max_depth = 6, taint_model = "PRORATA", budget = 60,
    persist = true
  } = req.body || {};

  if (!victim_id || !fraud_ts || !amount)
    return res.status(400).json({ error: "victim_id, fraud_ts and amount are required" });

  const victim = await one(`SELECT id FROM accounts WHERE id = $1`, [victim_id]);
  if (!victim) return res.status(404).json({ error: "victim account not found" });

  const result = await runCase({
    victimId: Number(victim_id),
    fraudTs: fraud_ts,
    amount: Number(amount),
    maxDepth: Number(max_depth),
    taintModel: taint_model === "FIFO" ? "FIFO" : "PRORATA",
    budget: Number(budget)
  });

  if (persist) {
    const row = await one(
      `INSERT INTO cases (victim_acct, amount, fraud_ts, max_depth, taint_model,
                          result, elapsed_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [victim_id, amount, fraud_ts, max_depth, taint_model,
       JSON.stringify(result.summary), result.elapsedMs]
    );
    result.caseId = row.id;

    const plan = result.plan?.knapsack?.chosen || [];
    for (const c of plan) {
      await q(
        `INSERT INTO freeze_actions (case_id, account_id, blocked, action_cost, chosen_by)
         VALUES ($1,$2,$3,$4,'KNAPSACK')`,
        [row.id, c.id, c.value, c.cost]
      );
    }
  }

  res.json(result);
});

/** Compare PRORATA vs FIFO on the same case — a nice "we thought about it" beat. */
r.post("/compare-taint", async (req, res) => {
  const { victim_id, fraud_ts, amount, max_depth = 6, budget = 60 } = req.body || {};
  if (!victim_id || !fraud_ts || !amount)
    return res.status(400).json({ error: "victim_id, fraud_ts and amount are required" });

  const base = {
    victimId: Number(victim_id), fraudTs: fraud_ts,
    amount: Number(amount), maxDepth: Number(max_depth), budget: Number(budget)
  };
  const [pro, fifo] = await Promise.all([
    runCase({ ...base, taintModel: "PRORATA" }),
    runCase({ ...base, taintModel: "FIFO" })
  ]);

  res.json({
    prorata: { summary: pro.summary, plan: pro.plan?.knapsack?.verified },
    fifo:    { summary: fifo.summary, plan: fifo.plan?.knapsack?.verified }
  });
});

/** LLM: victim narrative -> structured fields. */
r.post("/intake", async (req, res) => {
  const { narrative } = req.body || {};
  if (!narrative || narrative.trim().length < 10)
    return res.status(400).json({ error: "narrative is required" });

  const out = await chat(
    [{ role: "system", content: SYSTEM_INTAKE },
     { role: "user", content: intakePrompt(narrative) }],
    { json: true }
  );

  let parsed = out.ok ? parseJson(out.text) : null;

  if (!parsed) {
    // deterministic fallback: pull the biggest rupee figure and match keywords
    const amounts = [...narrative.matchAll(/(?:rs\.?|inr|₹)?\s*([\d][\d,]{3,})/gi)]
      .map((m) => Number(m[1].replace(/,/g, "")))
      .filter((n) => n >= 1000);
    const lower = narrative.toLowerCase();
    const playbook =
      /(cbi|police|arrest|custom|courier|parcel|fedex)/.test(lower) ? "DIGITAL_ARREST" :
      /(invest|trading|profit|stock)/.test(lower) ? "INVESTMENT" :
      /(job|interview|placement)/.test(lower) ? "JOB_OFFER" :
      /(kyc|update|block|expire)/.test(lower) ? "KYC_UPDATE" :
      /(otp)/.test(lower) ? "OTP_THEFT" : "OTHER";
    parsed = {
      amount: amounts.length ? Math.max(...amounts) : 0,
      fraud_time_hint: "",
      channel: /upi/i.test(narrative) ? "UPI" : "UNKNOWN",
      playbook,
      counterparty_hint: "",
      summary: narrative.slice(0, 180)
    };
  }

  const row = await one(
    `INSERT INTO reports (victim_acct, amount, fraud_ts, narrative, playbook)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.body.victim_id || null, parsed.amount || 0,
     req.body.fraud_ts || new Date(), narrative, parsed.playbook]
  ).catch(() => null);

  res.json({ extracted: parsed, report: row, grounded: out.ok });
});

/** LLM: investigator briefing for a computed result. */
r.post("/explain", async (req, res) => {
  const { result } = req.body || {};
  if (!result?.nodes) return res.status(400).json({ error: "result is required" });

  const out = await chat([
    { role: "system", content: SYSTEM_EXPLAIN },
    { role: "user", content: explainPrompt(result) }
  ]);

  if (out.ok && out.text.trim())
    return res.json({ text: out.text.trim(), grounded: true });

  // Fallback briefing, assembled from the same numbers the model would have used.
  const inr = (n) => "Rs " + Number(n || 0).toLocaleString("en-IN",
    { maximumFractionDigits: 0 });
  const plan = result.plan?.knapsack;
  const lines = [
    `${inr(result.amount)} left account #${result.victimId} and was split across ` +
    `${result.summary.tracedNodes - 1} accounts to a depth of ${result.summary.maxDepth}.`,
    `${inr(result.summary.exited)} has already left the banking system; ` +
    `${inr(result.summary.stillHeld)} is still sitting in accounts.`,
    "",
    "Recommended freezes:"
  ];
  for (const c of (plan?.chosen || []).slice(0, 6)) {
    const n = result.nodes.find((x) => x.id === c.id);
    lines.push(
      `  #${c.id} (${n?.bank}, ${n?.city}) — received ${inr(c.value)}; ` +
      `risk ${n?.riskScore}/100, dormant ${n?.dormancyDays}d before this, ` +
      `${n?.extCredits} salary credits, retention ${n?.retention}.`
    );
  }
  lines.push("",
    `Verified: this set blocks ${inr(plan?.verified?.blocked)} of ` +
    `${inr(plan?.verified?.baseline)} still in motion.`,
    "",
    "If challenged: the selected accounts show no salary credits, near-zero " +
    "retention, and received funds within minutes of the fraud — a pattern " +
    "inconsistent with ordinary personal banking.",
    "",
    "(Offline mode: assembled from computed values, no language model.)");

  res.json({ text: lines.join("\n"), grounded: false });
});

/** LLM: free-form question against one case. */
r.post("/ask", async (req, res) => {
  const { result, question } = req.body || {};
  if (!result?.nodes || !question)
    return res.status(400).json({ error: "result and question are required" });

  const out = await chat([
    { role: "system", content: SYSTEM_QUERY },
    { role: "user", content: queryPrompt(result, question) }
  ]);

  if (out.ok && out.text.trim())
    return res.json({ text: out.text.trim(), grounded: true });

  res.json({
    text: "The language model is unreachable, so I can only report computed " +
          `figures: ${result.summary.tracedNodes} accounts traced, ` +
          `${result.summary.operators} operator clusters, ` +
          `Rs ${Number(result.summary.recoverable).toLocaleString("en-IN")} recoverable.`,
    grounded: false
  });
});

r.get("/history", async (_req, res) => {
  res.json(await q(
    `SELECT c.id, c.victim_acct, c.amount, c.fraud_ts, c.taint_model,
            c.result, c.elapsed_ms, c.created_at
       FROM cases c ORDER BY c.created_at DESC LIMIT 50`));
});

export default r;
