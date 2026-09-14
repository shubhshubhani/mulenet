import { Router } from "express";
import { q, one } from "../db.js";
import { computeFeatures } from "../algo/features.js";

const r = Router();

r.get("/", async (req, res) => {
  const { search = "", limit = 50 } = req.query;
  const rows = await q(
    `SELECT id, acct_no, bank_code, ifsc, city, kyc_level, opened_at
       FROM accounts
      WHERE ($1 = '' OR acct_no ILIKE '%'||$1||'%' OR city ILIKE '%'||$1||'%'
             OR bank_code ILIKE '%'||$1||'%')
      ORDER BY id
      LIMIT $2`,
    [search, Math.min(Number(limit) || 50, 200)]
  );
  res.json(rows);
});

r.get("/:id", async (req, res) => {
  const acct = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
  if (!acct) return res.status(404).json({ error: "not found" });

  const recent = await q(
    `SELECT id, src, dst, amount, ts, channel
       FROM transactions
      WHERE src = $1 OR dst = $1
      ORDER BY ts DESC LIMIT 40`,
    [req.params.id]
  );

  const feats = await computeFeatures([Number(req.params.id)], new Date());

  // ground truth is returned for the demo panel only, clearly labelled
  res.json({
    account: {
      id: acct.id, acct_no: acct.acct_no, bank_code: acct.bank_code,
      ifsc: acct.ifsc, city: acct.city, lat: Number(acct.lat),
      lon: Number(acct.lon), kyc_level: acct.kyc_level,
      opened_at: acct.opened_at, opening_bal: Number(acct.opening_bal)
    },
    features: feats.get(Number(req.params.id)) || null,
    recent,
    groundTruth: { is_mule: acct.is_mule, is_cashout: acct.is_cashout }
  });
});

/** Bank/city rollup for the map legend. */
r.get("/meta/banks", async (_req, res) => {
  res.json(await q(`SELECT code, name, ifsc_pfx FROM banks ORDER BY name`));
});

export default r;
