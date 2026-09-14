/**
 * Creates the schema and loads a synthetic economy with injected fraud rings.
 * Run:  npm run db:setup
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { pool } from "./db.js";
import { generateWorld, srand, BANKS } from "./sim/generate.js";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const N_ACCOUNTS = Number(process.env.SIM_ACCOUNTS || 1200);
const DAYS       = Number(process.env.SIM_DAYS || 30);
const N_RINGS    = Number(process.env.SIM_RINGS || 40);

/** Bulk insert in chunks — one statement per row would take minutes. */
async function bulk(client, table, cols, rows, chunk = 800) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const tuples = slice.map((row, r) => {
      const ph = cols.map((_, c) => `$${r * cols.length + c + 1}`);
      params.push(...cols.map((c) => row[c]));
      return `(${ph.join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`,
      params
    );
  }
}

async function main() {
  const t0 = Date.now();
  const client = await pool.connect();

  try {
    console.log("Creating schema...");
    await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

    console.log("Loading banks...");
    await bulk(client, "banks", ["code", "name", "ifsc_pfx"],
      BANKS.map(([code, name, ifsc_pfx]) => ({ code, name, ifsc_pfx })));

    console.log(
      `Generating world: ${N_ACCOUNTS} accounts, ${DAYS} days, ${N_RINGS} rings...`);
    srand(20260918);
    const { accounts, txns, rings } = generateWorld({
      nAccounts: N_ACCOUNTS, days: DAYS, nRings: N_RINGS
    });

    console.log(`Inserting ${accounts.length} accounts...`);
    await bulk(client, "accounts",
      ["acct_no", "bank_code", "ifsc", "city", "lat", "lon", "holder_hash",
       "opened_at", "kyc_level", "opening_bal", "is_mule", "is_cashout"],
      accounts);

    // simulator used array indexes; map them to real serial ids
    const { rows: idRows } = await client.query(
      `SELECT id, acct_no FROM accounts ORDER BY id`);
    const idByAcctNo = new Map(idRows.map((r) => [r.acct_no, r.id]));
    const idByIdx = accounts.map((a) => idByAcctNo.get(a.acct_no));

    console.log(`Inserting ${txns.length} transactions...`);
    await bulk(client, "transactions",
      ["src", "dst", "amount", "ts", "channel", "ref_id", "is_fraud"],
      txns.map((t) => ({
        src: t.src === null ? null : idByIdx[t.src],
        dst: t.dst === null ? null : idByIdx[t.dst],
        amount: t.amount, ts: t.ts, channel: t.channel,
        ref_id: t.ref_id, is_fraud: t.is_fraud
      })), 500);

    console.log(`Inserting ${rings.length} fraud rings (ground truth)...`);
    for (const ring of rings) {
      const { rows } = await client.query(
        `INSERT INTO rings (label, victim_id, amount, fraud_ts, depth)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ring.label, idByIdx[ring.victim_idx], ring.amount,
         ring.fraud_ts, ring.depth]);
      const ringId = rows[0].id;
      await bulk(client, "ring_members", ["ring_id", "account_id", "layer"],
        ring.members.map((m) => ({
          ring_id: ringId,
          account_id: idByIdx[m.account_id],
          layer: m.layer
        })));
    }

    const { rows: [stat] } = await client.query(
      `SELECT (SELECT COUNT(*) FROM accounts)::int      AS accounts,
              (SELECT COUNT(*) FROM transactions)::int  AS txns,
              (SELECT COUNT(*) FROM rings)::int         AS rings,
              (SELECT COUNT(*) FROM accounts WHERE is_mule)::int AS mules`);

    console.log(`
  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s

    accounts      ${stat.accounts}
    transactions  ${stat.txns}
    fraud rings   ${stat.rings}
    mule accounts ${stat.mules}   (ground truth, used only for scoring)

  Start the API with:  npm start
`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
