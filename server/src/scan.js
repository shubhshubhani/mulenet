/**
 * Finds the best demo ring: one where knapsack visibly beats greedy.
 * Run:  node src/scan.js
 */
import dotenv from "dotenv";
import { pool, q } from "./db.js";
import { runCase } from "./algo/pipeline.js";

dotenv.config();

const BUDGETS = [25, 35, 50, 70];
const inr = (n) =>
  "Rs " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const rings = await q(
    `SELECT id, label, victim_id, amount, fraud_ts FROM rings ORDER BY label`);
  const found = [];

  for (const r of rings) {
    for (const budget of BUDGETS) {
      const res = await runCase({
        victimId: r.victim_id,
        fraudTs: r.fraud_ts,
        amount: Number(r.amount),
        maxDepth: 5,
        budget
      });
      const kn = res.plan?.knapsack?.verified?.blocked || 0;
      const gr = res.plan?.greedy?.verified?.blocked || 0;
      if (kn - gr > 0) {
        found.push({
          label: r.label, victim: r.victim_id, budget,
          kn, gr, adv: kn - gr,
          knCount: res.plan.knapsack.chosen.length,
          grCount: res.plan.greedy.chosen.length
        });
      }
    }
    process.stdout.write(".");
  }

  console.log("\n");
  found.sort((a, b) => b.adv - a.adv);

  if (!found.length) {
    console.log("  No ring showed an advantage. Add lower budgets to BUDGETS.\n");
  } else {
    console.log("  Rings where knapsack beats greedy (best first)\n");
    console.log("    ring       budget      knapsack        greedy     advantage");
    console.log("    " + "-".repeat(62));
    for (const f of found.slice(0, 15)) {
      console.log(`    ${f.label}  ${String(f.budget).padStart(6)}  ` +
        `${inr(f.kn).padStart(13)}  ${inr(f.gr).padStart(12)}  ${inr(f.adv).padStart(12)}`);
    }
    const b = found[0];
    console.log(`\n  USE THIS FOR THE DEMO\n`);
    console.log(`    ring      ${b.label}   (victim #${b.victim})`);
    console.log(`    budget    ${b.budget}`);
    console.log(`    knapsack  ${inr(b.kn)} with ${b.knCount} accounts`);
    console.log(`    greedy    ${inr(b.gr)} with ${b.grCount} accounts`);
    console.log(`    say       "same budget, ${inr(b.adv)} more money blocked"\n`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });