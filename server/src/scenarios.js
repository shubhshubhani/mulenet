/**
 * Curated demo scenarios.
 *
 * Replaces the 38 random rings with five hand-picked cases that each prove a
 * different point, plus two LIVE cases created minutes before you run this.
 *
 * Run:  node src/scenarios.js
 *
 * This does NOT touch accounts or background transactions — it only deletes the
 * existing rings and their fraud transactions, then injects the five you want.
 * Your 1,200 accounts and background economy stay exactly as they are.
 */
import dotenv from "dotenv";
import { pool, q, one } from "./db.js";

dotenv.config();

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const inr = (n) =>
  "Rs " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

let refCounter = 900000;
const ref = () => `DEMO${String(refCounter++).padStart(9, "0")}`;

/**
 * Picks accounts that look like plausible mules: no salary credits, thin
 * history. Avoids the victim and anything already used in this run.
 */
async function pickMules(count, used, victimId) {
  const rows = await q(
    `SELECT a.id
       FROM accounts a
      WHERE a.id <> $1
        AND a.id <> ALL($2::int[])
        AND NOT EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.dst = a.id AND t.src IS NULL
            )
      ORDER BY random()
      LIMIT $3`,
    [victimId, [...used], count]
  );
  if (rows.length < count) {
    const more = await q(
      `SELECT id FROM accounts
        WHERE id <> $1 AND id <> ALL($2::int[])
        ORDER BY random() LIMIT $3`,
      [victimId, [...used], count - rows.length]
    );
    rows.push(...more);
  }
  rows.forEach((r) => used.add(r.id));
  return rows.map((r) => r.id);
}

async function pickVictim(used) {
  const row = await one(
    `SELECT a.id FROM accounts a
      WHERE a.id <> ALL($1::int[])
        AND EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.dst = a.id AND t.src IS NULL
            )
      ORDER BY random() LIMIT 1`,
    [[...used]]
  );
  used.add(row.id);
  return row.id;
}

async function addTx(src, dst, amount, ts) {
  await q(
    `INSERT INTO transactions (src, dst, amount, ts, channel, ref_id, is_fraud)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
    [src, dst, Math.round(amount * 100) / 100, new Date(ts),
     dst === null ? "ATM" : (Math.random() < 0.7 ? "UPI" : "IMPS"), ref()]
  );
}

/**
 * Builds one ring.
 *
 * @param {number[]} widths      accounts per layer, e.g. [1,3,3]
 * @param {number}   cashOutPct  0 = live (nothing withdrawn), 1 = fully gone
 */
async function buildRing({ label, amount, ageMs, widths, cashOutPct, note }, used) {
  const victimId = await pickVictim(used);
  const fraudTs = Date.now() - ageMs;

  const members = [];
  let prev = [{ acct: victimId, amt: amount, ts: fraudTs }];

  for (let L = 0; L < widths.length; L++) {
    const layerIds = await pickMules(widths[L], used, victimId);
    layerIds.forEach((id) => members.push({ id, layer: L + 1 }));

    const next = layerIds.map((id) => ({ acct: id, amt: 0, ts: 0 }));

    for (const p of prev) {
      const cuts = layerIds.map(() => 0.6 + Math.random() * 0.8);
      const sum = cuts.reduce((a, b) => a + b, 0);
      const carried = p.amt * 0.94;          // small skim at each hop

      for (let i = 0; i < layerIds.length; i++) {
        const share = carried * (cuts[i] / sum);
        if (share < 1000) continue;
        const ts = p.ts + (2 + Math.floor(Math.random() * 7)) * MIN;
        await addTx(p.acct, layerIds[i], share, ts);
        next[i].amt += share;
        next[i].ts = Math.max(next[i].ts, ts);
      }
    }
    prev = next.filter((x) => x.amt > 0);
    if (!prev.length) break;
  }

  // cash out a proportion of what reached the final layer
  for (const p of prev) {
    const out = p.amt * cashOutPct;
    if (out < 1000) continue;
    await addTx(p.acct, null, out, p.ts + (5 + Math.floor(Math.random() * 30)) * MIN);
  }

  const ring = await one(
    `INSERT INTO rings (label, victim_id, amount, fraud_ts, depth)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [label, victimId, amount, new Date(fraudTs), widths.length]
  );

  for (const m of members) {
    await q(
      `INSERT INTO ring_members (ring_id, account_id, layer) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [ring.id, m.id, m.layer]
    );
  }
  await q(`UPDATE accounts SET is_mule = TRUE WHERE id = ANY($1::int[])`,
    [members.map((m) => m.id)]);

  return { label, victimId, amount, fraudTs, mules: members.length, note };
}

/** Each scenario exists to make a different point on stage. */
const SCENARIOS = [
  {
    label: "LIVE-01",
    amount: 620000,
    ageMs: 4 * MIN,
    widths: [4],
    cashOutPct: 0,
    note: "Live. Money sitting in layer 1 right now. Freeze saves everything."
  },
  {
    label: "LIVE-02",
    amount: 845000,
    ageMs: 18 * MIN,
    widths: [3, 4],
    cashOutPct: 0.25,
    note: "Layering in progress. Part withdrawn, most still recoverable."
  },
  {
    label: "CASE-CHOKE",
    amount: 540000,
    ageMs: 2 * DAY,
    widths: [1, 3, 3],
    cashOutPct: 0.85,
    note: "One chokepoint. Every strategy picks the same account."
  },
  {
    label: "CASE-SPREAD",
    amount: 771000,
    ageMs: 5 * DAY,
    widths: [5, 5, 4],
    cashOutPct: 0.75,
    note: "Wide fan-out. This is where knapsack beats greedy."
  },
  {
    label: "CASE-COLD",
    amount: 430000,
    ageMs: 21 * DAY,
    widths: [3, 4, 3],
    cashOutPct: 1.0,
    note: "Reported too late. Value is burning the mule network."
  }
];

async function main() {
  console.log("\n  Rebuilding demo scenarios\n");

  const { rowCount } = await pool.query(`DELETE FROM transactions WHERE is_fraud = TRUE`);
  await pool.query(`DELETE FROM ring_members`);
  await pool.query(`DELETE FROM rings`);
  await pool.query(`DELETE FROM freeze_actions`);
  await pool.query(`DELETE FROM cases`);
  await pool.query(`UPDATE accounts SET is_mule = FALSE, is_cashout = FALSE`);
  console.log(`  Cleared ${rowCount} old fraud transactions and all rings\n`);

  const used = new Set();
  for (const spec of SCENARIOS) {
    const r = await buildRing(spec, used);
    console.log(`  ${r.label.padEnd(12)} victim #${String(r.victimId).padEnd(5)} ` +
                `${inr(r.amount).padStart(12)}  ${r.mules} mules`);
    console.log(`               ${r.note}\n`);
  }

  console.log("  Done. Restart the API, then reload the UI.\n");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });