import { Router } from "express";
import crypto from "node:crypto";
import { q, one } from "../db.js";

const r = Router();

/**
 * Shared mule-flag registry — the off-chain half.
 *
 * The chain stores SALTED HASHES ONLY. Never an account number, never a name,
 * never an IFSC. This route is what turns a local account id into the hash that
 * goes on-chain, and what checks an incoming hash against our own records.
 *
 * The point of putting this on a chain at all: competing banks need to share
 * "this account is a mule" without any one of them owning the registry, and
 * without handing each other customer data. India already runs such a registry
 * across 61+ banks; this is an argument about the trust model, not an invented
 * need.
 */

const SALT = process.env.REGISTRY_SALT || "mulenet-demo-salt-v1";

export function accountHash(bankCode, acctNo) {
  return "0x" + crypto.createHash("sha256")
    .update(`${SALT}|${bankCode}|${acctNo}`).digest("hex");
}

export function evidenceHash(payload) {
  return "0x" + crypto.createHash("sha256")
    .update(JSON.stringify(payload)).digest("hex");
}

/** Turn a freeze plan into chain-ready submissions. */
r.post("/prepare", async (req, res) => {
  const { case_id, account_ids = [], summary = {} } = req.body || {};
  if (!account_ids.length)
    return res.status(400).json({ error: "account_ids required" });

  const accts = await q(
    `SELECT id, acct_no, bank_code FROM accounts WHERE id = ANY($1::int[])`,
    [account_ids]
  );

  const evidence = evidenceHash({
    case_id: case_id ?? null,
    accounts: accts.map((a) => a.id).sort(),
    summary
  });

  const submissions = accts.map((a) => ({
    accountId: a.id,
    bank: a.bank_code,
    accountHash: accountHash(a.bank_code, a.acct_no),
    severity: 3,
    evidenceHash: evidence
  }));

  res.json({
    caseHash: evidence,
    submissions,
    note: "Only salted hashes leave this service. No account number, holder " +
          "identifier or IFSC is ever written on-chain."
  });
});

/** Record the on-chain tx hash after the wallet confirms. */
r.post("/record", async (req, res) => {
  const { case_id, account_id, chain_tx } = req.body || {};
  const row = await one(
    `UPDATE freeze_actions SET chain_tx = $1
      WHERE case_id = $2 AND account_id = $3 RETURNING *`,
    [chain_tx, case_id, account_id]
  );
  if (!row) return res.status(404).json({ error: "freeze action not found" });
  res.json(row);
});

/**
 * Inbound check: another bank hands us a hash, we say whether we have seen it.
 * Demonstrates the cross-bank query without either side exposing customer data.
 */
r.post("/lookup", async (req, res) => {
  const { account_hash } = req.body || {};
  if (!account_hash) return res.status(400).json({ error: "account_hash required" });

  const accts = await q(
    `SELECT a.id, a.acct_no, a.bank_code,
            COUNT(f.id)::int AS times_flagged,
            MIN(f.created_at) AS first_flagged
       FROM accounts a
       LEFT JOIN freeze_actions f ON f.account_id = a.id
      GROUP BY a.id`);

  const hit = accts.find(
    (a) => accountHash(a.bank_code, a.acct_no).toLowerCase() ===
           String(account_hash).toLowerCase());

  if (!hit || !hit.times_flagged)
    return res.json({ known: false });

  res.json({
    known: true,
    timesFlagged: hit.times_flagged,
    firstFlagged: hit.first_flagged,
    // deliberately no account number, no bank, no holder
    note: "Match confirmed without disclosing the underlying account."
  });
});

export default r;
