/**
 * Command-line evaluation harness.
 * Run:  npm run evaluate
 *
 * Prints precision / recall / F1 against the injected ground-truth rings, plus
 * a threshold sweep. This is the slide that answers "your data is synthetic".
 */
import dotenv from "dotenv";
import { pool, q } from "./db.js";
import { runCase } from "./algo/pipeline.js";

dotenv.config();

const SAMPLE = Number(process.argv[2] || 20);
const THRESHOLDS = [25, 35, 45, 55, 65, 75];

const inr = (n) =>
  "Rs " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(1) + "%";

async function main() {
  const rings = await q(
    `SELECT id, label, victim_id, amount, fraud_ts
       FROM rings ORDER BY random() LIMIT $1`, [SAMPLE]);

  if (!rings.length) {
    console.error("No rings found. Run `npm run db:setup` first.");
    process.exit(1);
  }

  console.log(`\n  Evaluating ${rings.length} injected fraud rings\n`);

  const cached = [];
  const latencies = [];
  let defrauded = 0, recoverable = 0, exited = 0;

  for (const ring of rings) {
    const truth = await q(
      `SELECT account_id FROM ring_members WHERE ring_id = $1`, [ring.id]);
    const result = await runCase({
      victimId: ring.victim_id,
      fraudTs: ring.fraud_ts,
      amount: Number(ring.amount),
      maxDepth: 6,
      budget: 60
    });
    cached.push({ ring, truth: new Set(truth.map((t) => t.account_id)), result });
    latencies.push(result.elapsedMs);
    defrauded   += Number(ring.amount);
    recoverable += result.summary.recoverable || 0;
    exited      += result.summary.exited || 0;

    process.stdout.write(
      `    ${ring.label}  traced ${String(result.summary.tracedNodes).padStart(3)} accounts  ` +
      `depth ${result.summary.maxDepth}  ${String(result.elapsedMs).padStart(4)}ms\n`);
  }

  console.log("\n  Threshold sweep\n");
  console.log("    risk>=   precision    recall        F1");
  console.log("    " + "-".repeat(42));

  let best = null;
  for (const th of THRESHOLDS) {
    let tp = 0, fp = 0, fn = 0;
    for (const { truth, result } of cached) {
      const flagged = new Set(result.nodes
        .filter((n) => !n.isVictim && (n.riskScore ?? 0) >= th)
        .map((n) => n.id));
      for (const id of flagged) (truth.has(id) ? tp++ : fp++);
      fn += [...truth].filter((id) => !flagged.has(id)).length;
    }
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    const f1 = p + r ? (2 * p * r) / (p + r) : 0;
    if (!best || f1 > best.f1) best = { th, p, r, f1 };
    console.log(
      `    ${String(th).padStart(5)}   ${pct(p).padStart(8)}  ${pct(r).padStart(8)}  ${pct(f1).padStart(8)}`);
  }

  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || median;

  // how much better is knapsack than the greedy baseline?
  const advantages = cached
    .map(({ result }) =>
      (result.plan?.knapsack?.verified?.blocked || 0) -
      (result.plan?.greedy?.verified?.blocked || 0))
    .filter((x) => Number.isFinite(x));
  const avgAdv = advantages.reduce((a, b) => a + b, 0) / (advantages.length || 1);
  const wins = advantages.filter((a) => a > 0).length;

  console.log(`
  Best operating point   risk >= ${best.th}
    precision            ${pct(best.p)}
    recall               ${pct(best.r)}
    F1                   ${pct(best.f1)}

  Money
    total defrauded      ${inr(defrauded)}
    recoverable          ${inr(recoverable)}   (${pct(recoverable / defrauded)})
    already exited       ${inr(exited)}

  Freeze planning
    knapsack beat greedy in ${wins}/${advantages.length} cases
    mean advantage       ${inr(avgAdv)} per case

  Latency
    median               ${median} ms
    p95                  ${p95} ms
`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
