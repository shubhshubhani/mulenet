import { Router } from "express";
import { q } from "../db.js";
import { runCase } from "../algo/pipeline.js";

const r = Router();

/**
 * Evaluation harness.
 *
 * This route is the answer to "your data is synthetic, so how do we know it
 * works?" Because every injected ring is recorded, we know exactly which
 * accounts were mules. So we can run the detector over N rings and report
 * precision, recall, F1 and time-to-detection — which a project running on
 * real data with no labels cannot do at all.
 *
 * Ground truth (accounts.is_mule, ring_members) is read ONLY here.
 */
r.post("/evaluate", async (req, res) => {
  const {
    sample = 15,
    threshold = 45,      // riskScore cut-off for calling an account a mule
    max_depth = 6,
    budget = 60
  } = req.body || {};

  const rings = await q(
    `SELECT id, label, victim_id, amount, fraud_ts
       FROM rings ORDER BY random() LIMIT $1`,
    [Math.min(Number(sample) || 15, 60)]
  );

  let tp = 0, fp = 0, fn = 0;
  let recoverableTotal = 0, exitedTotal = 0, amountTotal = 0;
  const latencies = [];
  const perCase = [];

  for (const ring of rings) {
    const truth = await q(
      `SELECT account_id FROM ring_members WHERE ring_id = $1`, [ring.id]);
    const truthSet = new Set(truth.map((t) => t.account_id));

    const result = await runCase({
      victimId: ring.victim_id,
      fraudTs: ring.fraud_ts,
      amount: Number(ring.amount),
      maxDepth: Number(max_depth),
      budget: Number(budget)
    });

    const flagged = new Set(
      result.nodes
        .filter((n) => !n.isVictim && (n.riskScore ?? 0) >= threshold)
        .map((n) => n.id)
    );

    let ctp = 0, cfp = 0;
    for (const id of flagged) (truthSet.has(id) ? ctp++ : cfp++);
    const cfn = [...truthSet].filter((id) => !flagged.has(id)).length;

    tp += ctp; fp += cfp; fn += cfn;
    latencies.push(result.elapsedMs);
    recoverableTotal += result.summary.recoverable || 0;
    exitedTotal += result.summary.exited || 0;
    amountTotal += Number(ring.amount);

    perCase.push({
      ring: ring.label,
      victim: ring.victim_id,
      amount: Number(ring.amount),
      traced: result.summary.tracedNodes,
      truthSize: truthSet.size,
      tp: ctp, fp: cfp, fn: cfn,
      recoverable: result.summary.recoverable,
      elapsedMs: result.elapsedMs
    });
  }

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  latencies.sort((a, b) => a - b);

  res.json({
    config: { sample: rings.length, threshold, max_depth, budget },
    metrics: {
      truePositives: tp, falsePositives: fp, falseNegatives: fn,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000
    },
    money: {
      totalDefrauded: Math.round(amountTotal),
      totalRecoverable: Math.round(recoverableTotal),
      totalExited: Math.round(exitedTotal),
      recoveryRate: amountTotal
        ? Math.round((recoverableTotal / amountTotal) * 1000) / 1000 : 0
    },
    latency: {
      medianMs: latencies[Math.floor(latencies.length / 2)] || 0,
      p95Ms: latencies[Math.floor(latencies.length * 0.95)] || 0
    },
    perCase
  });
});

/** Precision/recall as the threshold sweeps — the curve for the slide. */
r.post("/sweep", async (req, res) => {
  const { sample = 8, thresholds = [25, 35, 45, 55, 65, 75] } = req.body || {};

  const rings = await q(
    `SELECT id, victim_id, amount, fraud_ts FROM rings ORDER BY random() LIMIT $1`,
    [Math.min(Number(sample) || 8, 25)]
  );

  const cached = [];
  for (const ring of rings) {
    const truth = await q(
      `SELECT account_id FROM ring_members WHERE ring_id = $1`, [ring.id]);
    const result = await runCase({
      victimId: ring.victim_id, fraudTs: ring.fraud_ts,
      amount: Number(ring.amount), maxDepth: 6, budget: 60
    });
    cached.push({ truth: new Set(truth.map((t) => t.account_id)), result });
  }

  const points = thresholds.map((th) => {
    let tp = 0, fp = 0, fn = 0;
    for (const { truth, result } of cached) {
      const flagged = new Set(result.nodes
        .filter((n) => !n.isVictim && (n.riskScore ?? 0) >= th)
        .map((n) => n.id));
      for (const id of flagged) (truth.has(id) ? tp++ : fp++);
      fn += [...truth].filter((id) => !flagged.has(id)).length;
    }
    const p = tp + fp ? tp / (tp + fp) : 0;
    const rc = tp + fn ? tp / (tp + fn) : 0;
    return {
      threshold: th,
      precision: Math.round(p * 1000) / 1000,
      recall: Math.round(rc * 1000) / 1000,
      f1: p + rc ? Math.round(((2 * p * rc) / (p + rc)) * 1000) / 1000 : 0
    };
  });

  res.json({ sample: rings.length, points });
});

/** Dataset headline numbers for the dashboard. */
r.get("/stats", async (_req, res) => {
  const [acc] = await q(`SELECT COUNT(*)::int AS n FROM accounts`);
  const [tx] = await q(`SELECT COUNT(*)::int AS n FROM transactions`);
  const [rg] = await q(`SELECT COUNT(*)::int AS n FROM rings`);
  const [mule] = await q(`SELECT COUNT(*)::int AS n FROM accounts WHERE is_mule`);
  const [span] = await q(
    `SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM transactions`);
  res.json({
    accounts: acc.n, transactions: tx.n, rings: rg.n, muleAccounts: mule.n,
    window: span
  });
});

export default r;
