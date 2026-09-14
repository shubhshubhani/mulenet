/**
 * Synthetic transaction economy with injected fraud rings.
 *
 * Why this file matters more than any other: the algorithms are only as
 * trustworthy as the data they run on. Because every injected ring is recorded
 * in `rings` / `ring_members`, we have GROUND TRUTH — which is what lets us
 * report precision, recall and time-to-detection instead of just asserting the
 * system "works".
 *
 * The ground-truth columns (accounts.is_mule, transactions.is_fraud) are NEVER
 * read by the detection code. They are only read by evaluate.js.
 */
import crypto from "node:crypto";

// ── deterministic RNG so a demo is reproducible ──────────────────────────
let _seed = 20260918;
export function srand(s) { _seed = s >>> 0; }
function rnd() {
  // mulberry32
  _seed = (_seed + 0x6D2B79F5) >>> 0;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// ── reference data ───────────────────────────────────────────────────────
export const BANKS = [
  ["SBIN", "State Bank of India", "SBIN0"],
  ["HDFC", "HDFC Bank", "HDFC0"],
  ["ICIC", "ICICI Bank", "ICIC0"],
  ["UTIB", "Axis Bank", "UTIB0"],
  ["PUNB", "Punjab National Bank", "PUNB0"],
  ["KKBK", "Kotak Mahindra Bank", "KKBK0"],
  ["BARB", "Bank of Baroda", "BARB0"],
  ["IDIB", "Indian Bank", "IDIB0"],
  ["YESB", "Yes Bank", "YESB0"],
  ["AIRP", "Airtel Payments Bank", "AIRP0"]
];

// lat/lon so the layering can be drawn on a real map
export const CITIES = [
  ["Kolkata",    22.5726, 88.3639],
  ["Howrah",     22.5958, 88.2636],
  ["Durgapur",   23.5204, 87.3119],
  ["Siliguri",   26.7271, 88.3953],
  ["Patna",      25.5941, 85.1376],
  ["Ranchi",     23.3441, 85.3096],
  ["Bhubaneswar",20.2961, 85.8245],
  ["Guwahati",   26.1445, 91.7362],
  ["Delhi",      28.6139, 77.2090],
  ["Noida",      28.5355, 77.3910],
  ["Jaipur",     26.9124, 75.7873],
  ["Lucknow",    26.8467, 80.9462],
  ["Mumbai",     19.0760, 72.8777],
  ["Pune",       18.5204, 73.8567],
  ["Ahmedabad",  23.0225, 72.5714],
  ["Indore",     22.7196, 75.8577],
  ["Bengaluru",  12.9716, 77.5946],
  ["Hyderabad",  17.3850, 78.4867],
  ["Chennai",    13.0827, 80.2707],
  ["Kochi",      9.9312,  76.2673]
];

const CHANNELS_P2P = ["UPI", "UPI", "UPI", "IMPS", "NEFT"];

function hashHolder(i) {
  return crypto.createHash("sha256")
    .update(`holder:${i}:mulenet-demo-salt`).digest("hex").slice(0, 32);
}

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/**
 * Build the whole synthetic world in memory, then the caller bulk-inserts it.
 *
 * @returns {{accounts:Array, txns:Array, rings:Array}}
 */
export function generateWorld({
  nAccounts = 1200,
  days = 30,
  nRings = 40,
  endTime = Date.now()
} = {}) {
  const start = endTime - days * DAY;
  const accounts = [];
  const txns = [];
  const rings = [];

  // ── 1. accounts ────────────────────────────────────────────────────────
  for (let i = 0; i < nAccounts; i++) {
    const [bankCode, , pfx] = pick(BANKS);
    const [city, lat, lon] = pick(CITIES);
    // jitter so markers don't stack exactly on top of each other
    const jlat = lat + (rnd() - 0.5) * 0.12;
    const jlon = lon + (rnd() - 0.5) * 0.12;

    // Most accounts are old. Mule accounts tend to be newer — but we do NOT
    // rely on that alone, or detection would be trivially circular.
    const ageDays = chance(0.82) ? ri(200, 3000) : ri(5, 190);

    accounts.push({
      idx: i,
      acct_no: String(50100000000 + i * 7 + ri(0, 6)),
      bank_code: bankCode,
      ifsc: pfx + String(ri(100000, 999999)),
      city, lat: jlat, lon: jlon,
      holder_hash: hashHolder(i),
      opened_at: new Date(endTime - ageDays * DAY),
      kyc_level: chance(0.9) ? "FULL" : "MIN",
      opening_bal: ri(2000, 90000),
      is_mule: false,
      is_cashout: false
    });
  }

  const nMerchants = Math.max(20, Math.floor(nAccounts * 0.06));
  const merchants = new Set();
  while (merchants.size < nMerchants) merchants.add(ri(0, nAccounts - 1));
  const merchantList = [...merchants];

  let refCounter = 1;
  const ref = () => `TXN${String(refCounter++).padStart(9, "0")}`;

  const addTx = (src, dst, amount, ts, channel, isFraud = false) => {
    txns.push({
      src, dst,
      amount: Math.round(amount * 100) / 100,
      ts: new Date(ts),
      channel,
      ref_id: ref(),
      is_fraud: isFraud
    });
  };

  // ── 2. background economy ──────────────────────────────────────────────
  // Salary credits: external money in, monthly, for most accounts.
  for (let i = 0; i < nAccounts; i++) {
    if (merchants.has(i)) continue;
    if (!chance(0.62)) continue;
    const salary = ri(18000, 120000);
    const payDay = ri(1, 3);
    for (let d = payDay; d < days; d += 30) {
      const ts = start + d * DAY + ri(9, 11) * HOUR + ri(0, 59) * MIN;
      if (ts > endTime) break;
      addTx(null, i, salary, ts, "NEFT");
    }
  }

  // Merchant spend: everyday UPI payments. Power-law-ish: a few merchants get
  // most of the volume, which is what real payment graphs look like.
  const spendEvents = nAccounts * days * 0.9;
  for (let k = 0; k < spendEvents; k++) {
    const src = ri(0, nAccounts - 1);
    if (merchants.has(src)) continue;
    // bias toward the head of the merchant list
    const mIdx = Math.floor(Math.pow(rnd(), 2.2) * merchantList.length);
    const dst = merchantList[Math.min(mIdx, merchantList.length - 1)];
    if (src === dst) continue;
    const ts = start + rnd() * (endTime - start);
    const hour = new Date(ts).getHours();
    // daytime bias
    if (hour < 7 && chance(0.8)) continue;
    addTx(src, dst, ri(60, 4200), ts, "UPI");
  }

  // Peer-to-peer transfers between individuals.
  const p2pEvents = nAccounts * days * 0.22;
  for (let k = 0; k < p2pEvents; k++) {
    const src = ri(0, nAccounts - 1);
    const dst = ri(0, nAccounts - 1);
    if (src === dst) continue;
    const ts = start + rnd() * (endTime - start);
    addTx(src, dst, ri(200, 28000), ts, pick(CHANNELS_P2P));
  }

  // Ordinary ATM withdrawals, so "money leaving the system" is not by itself
  // a fraud signal.
  const atmEvents = nAccounts * days * 0.10;
  for (let k = 0; k < atmEvents; k++) {
    const src = ri(0, nAccounts - 1);
    const ts = start + rnd() * (endTime - start);
    addTx(src, null, ri(500, 20000) , ts, "ATM");
  }

  // ── 3. injected fraud rings ────────────────────────────────────────────
  // Shape: victim -> L1 fan-out -> L2 (partial reconvergence) -> ... -> exit.
  // Fast, high-value, off-hours, and geographically dispersed.
  const usedMules = new Set();

  for (let r = 0; r < nRings; r++) {
    const victim = ri(0, nAccounts - 1);
    if (merchants.has(victim)) { continue; }

    const amount = ri(80000, 900000);
    // Frauds cluster in the evening / late night.
    const dayOffset = ri(2, days - 2);
    const fraudTs = start + dayOffset * DAY + ri(19, 23) * HOUR + ri(0, 59) * MIN;
    const depth = ri(3, 5);

    const layers = [];
    let prevLayer = [{ acct: victim, amt: amount, ts: fraudTs }];
    const members = [];

    let ok = true;
    for (let L = 1; L <= depth && ok; L++) {
      const isLast = L === depth;
      const width = isLast ? ri(2, 3) : ri(2, 4);

      // choose fresh mule accounts, preferring newer / low-KYC ones
      const layerAccts = [];
      let guard = 0;
      while (layerAccts.length < width && guard++ < 400) {
        const cand = ri(0, nAccounts - 1);
        if (cand === victim || merchants.has(cand)) continue;
        if (usedMules.has(cand) && !chance(0.08)) continue; // small reuse: syndicates share accounts
        if (layerAccts.includes(cand)) continue;
        layerAccts.push(cand);
      }
      if (layerAccts.length === 0) { ok = false; break; }
      layerAccts.forEach((a) => {
        usedMules.add(a);
        accounts[a].is_mule = true;
        members.push({ account_id: a, layer: L });
      });

      // distribute money from prev layer into this layer
      const nextLayer = layerAccts.map((a) => ({ acct: a, amt: 0, ts: 0 }));
      for (const p of prevLayer) {
        // split p.amt across a random subset of this layer
        const targets = layerAccts
          .filter(() => chance(0.75))
          .slice(0, Math.max(1, width));
        const chosen = targets.length ? targets : [pick(layerAccts)];
        let remaining = p.amt * (0.90 + rnd() * 0.08); // small skim at each hop
        const cuts = chosen.map(() => 0.5 + rnd());
        const cutSum = cuts.reduce((a, b) => a + b, 0);
        chosen.forEach((t, i) => {
          const share = remaining * (cuts[i] / cutSum);
          if (share < 500) return;
          // layering is fast: 1-9 minutes per hop
          const ts = p.ts + ri(1, 9) * MIN + ri(0, 59) * 1000;
          addTx(p.acct, t, share, ts, chance(0.75) ? "UPI" : "IMPS", true);
          const slot = nextLayer.find((x) => x.acct === t);
          slot.amt += share;
          slot.ts = Math.max(slot.ts, ts);
        });
      }

      const alive = nextLayer.filter((x) => x.amt > 0);
      if (!alive.length) { ok = false; break; }
      layers.push(alive);
      prevLayer = alive;
    }

    if (!ok || !prevLayer.length) continue;

    // exit: cash-out at ATM or off-ramp
    for (const p of prevLayer) {
      accounts[p.acct].is_cashout = true;
      const nWith = ri(1, 3);
      let left = p.amt * (0.85 + rnd() * 0.1);
      for (let w = 0; w < nWith && left > 1000; w++) {
        const amt = w === nWith - 1 ? left : left * (0.4 + rnd() * 0.3);
        const ts = p.ts + ri(2, 40) * MIN;
        addTx(p.acct, null, amt, ts, chance(0.6) ? "ATM" : "CARD", true);
        left -= amt;
      }
    }

    rings.push({
      label: `RING-${String(r + 1).padStart(3, "0")}`,
      victim_idx: victim,
      amount,
      fraud_ts: new Date(fraudTs),
      depth,
      members
    });
  }

  txns.sort((a, b) => a.ts - b.ts);
  return { accounts, txns, rings };
}
