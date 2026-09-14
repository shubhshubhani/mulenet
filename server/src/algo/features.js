/**
 * Behavioural features, risk score, and action cost.
 *
 * The Indian Banks' Association profile of a mule account gives us real
 * features to build against rather than invented ones: frequent transactions,
 * an unusually high number of counterparties, rapid movement of funds, and
 * sudden spikes in activity after dormancy.
 *
 * Two numbers come out of this file:
 *
 *   riskScore  (0-100)  how mule-like this account behaves. This is what the
 *                       evaluation harness scores against ground truth.
 *
 *   actionCost (1-100)  how expensive it is to freeze this account, i.e. how
 *                       much collateral damage a false positive would do. An
 *                       account with regular salary credits, a long history and
 *                       many counterparties is expensive. A dormant account
 *                       that woke up an hour ago is cheap.
 *
 * NOTE: accounts.is_mule is ground truth and is deliberately NOT read here.
 * Everything below is derived from observable behaviour only.
 */
import { q } from "../db.js";

const DAY = 86400000;

/** Haversine, km. Used for the geographic-velocity signal. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Compute features for a set of accounts, relative to a case time.
 * One round-trip for the whole set rather than N queries.
 */
export async function computeFeatures(accountIds, caseTs) {
  if (!accountIds.length) return new Map();
  const ref = +new Date(caseTs);

  const accts = await q(
    `SELECT id, opened_at, kyc_level, city, lat, lon, bank_code
       FROM accounts WHERE id = ANY($1::int[])`,
    [accountIds]
  );

  const agg = await q(
    `SELECT a.id,
            COUNT(t.id)                                        AS tx_count,
            COUNT(DISTINCT COALESCE(t.src, -1))                AS in_parties,
            COUNT(DISTINCT COALESCE(t.dst, -1))                AS out_parties,
            COUNT(*) FILTER (WHERE t.src IS NULL)              AS ext_credits,
            COUNT(*) FILTER (WHERE t.dst IS NULL)              AS cash_exits,
            COALESCE(SUM(t.amount) FILTER (WHERE t.dst = a.id), 0) AS total_in,
            COALESCE(SUM(t.amount) FILTER (WHERE t.src = a.id), 0) AS total_out,
            MAX(t.ts) FILTER (WHERE t.ts < $2)                 AS last_before,
            COUNT(*) FILTER (WHERE t.ts < $2)                  AS tx_before
       FROM accounts a
       LEFT JOIN transactions t ON (t.src = a.id OR t.dst = a.id)
      WHERE a.id = ANY($1::int[])
      GROUP BY a.id`,
    [accountIds, new Date(ref)]
  );

  const byId = new Map();
  for (const a of accts) byId.set(a.id, { ...a });
  for (const g of agg) {
    const rec = byId.get(g.id);
    if (rec) Object.assign(rec, g);
  }

  const out = new Map();
  for (const [id, r] of byId) {
    const ageDays = Math.max(1, (ref - +new Date(r.opened_at)) / DAY);
    const txCount = Number(r.tx_count || 0);
    const txBefore = Number(r.tx_before || 0);
    const extCredits = Number(r.ext_credits || 0);
    const totalIn = Number(r.total_in || 0);
    const totalOut = Number(r.total_out || 0);
    const counterparties =
      Number(r.in_parties || 0) + Number(r.out_parties || 0);
    const cashExits = Number(r.cash_exits || 0);

    // days of silence immediately before the case
    const dormancyDays = r.last_before
      ? (ref - +new Date(r.last_before)) / DAY
      : ageDays;

    // how much of what arrives actually stays — mules retain almost nothing
    const retention = totalIn > 0 ? Math.max(0, (totalIn - totalOut) / totalIn) : 1;

    // activity rate before the case
    const txPerDay = txBefore / Math.max(1, Math.min(ageDays, 90));

    // ── risk score ──────────────────────────────────────────────────────
    let risk = 0;
    if (ageDays < 120) risk += 18;                       // young account
    else if (ageDays < 365) risk += 8;
    if (extCredits === 0) risk += 16;                    // no salary / no real income
    if (retention < 0.06) risk += 22;                    // pure pass-through
    else if (retention < 0.2) risk += 10;
    if (dormancyDays > 45 && txBefore > 0) risk += 16;   // dormant, then spike
    if (txPerDay < 0.15) risk += 8;                      // thin genuine history
    if (cashExits > 0) risk += 10;                       // exits the system
    if (r.kyc_level === "MIN") risk += 6;
    if (counterparties > 25) risk += 4;                  // high fan
    risk = Math.max(0, Math.min(100, risk));

    // ── action cost: the inverse idea ───────────────────────────────────
    // How much does freezing this hurt someone innocent?
    let cost = 12;
    if (extCredits >= 2) cost += 34;                     // salary account
    else if (extCredits === 1) cost += 14;
    if (ageDays > 730) cost += 18;
    else if (ageDays > 365) cost += 10;
    if (retention > 0.35) cost += 16;                    // holds a real balance
    if (txPerDay > 1.2) cost += 14;                      // genuinely active
    if (counterparties > 30) cost += 6;
    if (dormancyDays > 45 && txBefore > 0) cost -= 12;   // dormant-then-spike is cheap
    if (extCredits === 0 && retention < 0.06) cost -= 10;
    cost = Math.max(5, Math.min(100, Math.round(cost)));

    out.set(id, {
      id,
      city: r.city,
      lat: Number(r.lat),
      lon: Number(r.lon),
      bank: r.bank_code,
      ageDays: Math.round(ageDays),
      txCount,
      extCredits,
      counterparties,
      cashExits,
      dormancyDays: Math.round(dormancyDays * 10) / 10,
      retention: Math.round(retention * 1000) / 1000,
      txPerDay: Math.round(txPerDay * 100) / 100,
      riskScore: Math.round(risk),
      actionCost: cost
    });
  }
  return out;
}

/**
 * Geographic velocity.
 *
 * Money surfacing 1,400 km away four minutes later is not a visual flourish —
 * it is an anomaly feature. No physical person moved; the account network did.
 * Implausible implied speed is a strong hint that the hop is part of a
 * coordinated layering chain rather than an ordinary transfer.
 */
export function geoVelocity(edges, featureMap) {
  return edges.map((e) => {
    const a = featureMap.get(e.from);
    const b = featureMap.get(e.to);
    if (!a || !b) return { ...e, km: null, kmph: null };
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const hrs = Math.max(e.hopSeconds || 60, 60) / 3600;
    return {
      ...e,
      km: Math.round(km),
      kmph: Math.round(km / hrs),
      implausible: km > 400 && hrs < 0.5
    };
  });
}
