/**
 * Time-respecting traversal + taint attribution.
 *
 * This is the correctness core of the whole project.
 *
 * Two ideas do all the work:
 *
 *  1. TIME-RESPECTING TRAVERSAL.  Money can only flow forward in time. A
 *     transfer that left an account at 21:31 cannot possibly carry money that
 *     arrived at 21:33. So this is NOT a plain BFS over the account graph — an
 *     edge is only traversable if its timestamp is strictly after the moment
 *     the taint arrived at its source. Ignoring this is the single most common
 *     way naive money-trail tools produce nonsense.
 *
 *  2. TAINT ATTRIBUTION.  When an account holds Rs 5L of which Rs 1L is dirty
 *     and then sends out Rs 2L, how much of that Rs 2L is dirty? Two standard
 *     forensic answers, both implemented here:
 *
 *       PRORATA — the outgoing transfer carries dirty money in the same
 *                 proportion as the account's balance.  (default)
 *       FIFO    — "first in, first out": the oldest money in the account
 *                 leaves first, so taint is consumed in arrival order.
 *
 *     Without this, every hop over-claims taint and the system ends up
 *     recommending freezes on balances that were never the victim's.
 *
 * Complexity: O(V + E) over the discovered subgraph, plus one sort.
 */
import { q } from "../db.js";

const INF_NODES = 6000;

/**
 * Phase 1 — bounded discovery.
 *
 * Walks forward in time from the victim to find which accounts could possibly
 * have received the money, ignoring amounts. This deliberately OVER-approximates
 * (it is a superset of the truly tainted set) so that phase 2 has every edge it
 * needs to compute exact shares. Bounding by depth and node count keeps a single
 * case from walking the entire economy.
 */
export async function discoverCandidates(victimId, fraudTs, maxDepth = 6,
                                         maxNodes = INF_NODES) {
  const arrival = new Map([[victimId, +new Date(fraudTs)]]);
  const depth = new Map([[victimId, 0]]);
  let frontier = [victimId];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    if (arrival.size >= maxNodes) break;

    const minTs = Math.min(...frontier.map((id) => arrival.get(id)));
    const rows = await q(
      `SELECT src, dst, ts
         FROM transactions
        WHERE src = ANY($1::int[])
          AND dst IS NOT NULL
          AND ts > $2
        ORDER BY ts ASC`,
      [frontier, new Date(minTs)]
    );

    const next = [];
    for (const r of rows) {
      const t = +new Date(r.ts);
      // the per-node time filter: this edge must post-date the taint arriving
      // at ITS OWN source, not merely the batch minimum
      if (t <= arrival.get(r.src)) continue;

      const prev = arrival.get(r.dst);
      if (prev === undefined) {
        arrival.set(r.dst, t);
        depth.set(r.dst, d + 1);
        next.push(r.dst);
        if (arrival.size >= maxNodes) break;
      } else if (t < prev) {
        // reached the same account earlier by another path
        arrival.set(r.dst, t);
        if (depth.get(r.dst) > d + 1) depth.set(r.dst, d + 1);
      }
    }
    frontier = [...new Set(next)];
  }

  return { ids: [...arrival.keys()], arrival, depth };
}

/**
 * Phase 2 — exact taint propagation.
 *
 * Sweeps every transaction touching the candidate set in strict global time
 * order, maintaining a running balance and a taint pool per account. Processing
 * in time order is what makes the pro-rata denominator correct: we always know
 * the balance as it stood at the instant of the outgoing transfer.
 */
export async function traceTaint({
  victimId,
  fraudTs,
  amount,
  maxDepth = 6,
  taintModel = "PRORATA",
  minTaint = 100          // ignore dust so the graph stays readable
}) {
  const t0 = Date.now();
  const fraudMs = +new Date(fraudTs);

  const { ids, depth: discDepth } = await discoverCandidates(
    victimId, fraudTs, maxDepth);

  if (!ids.length) {
    return { nodes: [], edges: [], exits: [], stats: {} };
  }

  // Every transaction that touches a candidate — including edges to
  // non-candidates, because those still change the balance and therefore the
  // pro-rata denominator.
  const txns = await q(
    `SELECT id, src, dst, amount, ts, channel
       FROM transactions
      WHERE src = ANY($1::int[]) OR dst = ANY($1::int[])
      ORDER BY ts ASC, id ASC`,
    [ids]
  );

  const accts = await q(
    `SELECT id, opening_bal FROM accounts WHERE id = ANY($1::int[])`,
    [ids]
  );

  const balance = new Map();
  for (const a of accts) balance.set(a.id, Number(a.opening_bal));

  // taint state
  const pool = new Map();        // account -> tainted rupees currently held
  const lots = new Map();        // account -> [{amt, dirty}]  (FIFO model only)
  const received = new Map();    // account -> total tainted rupees ever received
  const firstSeen = new Map();   // account -> ts of first tainted receipt
  const nodeDepth = new Map([[victimId, 0]]);
  const edges = [];              // tainted edges actually used
  const exits = [];              // tainted money leaving the system

  const getBal = (id) => (balance.has(id) ? balance.get(id) : 0);

  // Seed: the victim held the money immediately before the fraud.
  pool.set(victimId, Number(amount));
  received.set(victimId, Number(amount));
  firstSeen.set(victimId, fraudMs);
  if (taintModel === "FIFO") {
    lots.set(victimId, [{ amt: Number(amount), dirty: true }]);
  }

  for (const tx of txns) {
    const ts = +new Date(tx.ts);
    const amt = Number(tx.amount);
    const src = tx.src;
    const dst = tx.dst;

    // --- external credit (salary etc.): clean money in -------------------
    if (src === null) {
      if (dst !== null) {
        balance.set(dst, getBal(dst) + amt);
        if (taintModel === "FIFO") {
          const l = lots.get(dst) || [];
          l.push({ amt, dirty: false });
          lots.set(dst, l);
        }
      }
      continue;
    }

    const srcPool = pool.get(src) || 0;
    const balBefore = getBal(src);

    // How much of this outgoing transfer is the victim's money?
    let carried = 0;
    const eligible = srcPool > 0 && ts > (firstSeen.get(src) ?? Infinity);

    if (eligible) {
      if (taintModel === "FIFO") {
        // oldest rupees leave first
        const l = lots.get(src) || [];
        let need = amt;
        while (need > 0.0001 && l.length) {
          const lot = l[0];
          const take = Math.min(lot.amt, need);
          if (lot.dirty) carried += take;
          lot.amt -= take;
          need -= take;
          if (lot.amt <= 0.0001) l.shift();
        }
        lots.set(src, l);
      } else {
        // PRORATA: the transfer carries dirty money in the same proportion as
        // the account's balance at this instant.
        const denom = Math.max(balBefore, srcPool);
        const fraction = denom > 0 ? Math.min(1, srcPool / denom) : 0;
        carried = amt * fraction;
      }
      carried = Math.min(carried, srcPool);
      if (carried > 0) pool.set(src, srcPool - carried);
    }

    // --- apply the movement to balances ----------------------------------
    balance.set(src, balBefore - amt);

    if (dst === null) {
      // money leaves the banking system: ATM / card / off-ramp
      if (carried >= minTaint) {
        exits.push({
          txId: tx.id, from: src, amount: amt, tainted: carried,
          ts: tx.ts, channel: tx.channel
        });
      }
      continue;
    }

    balance.set(dst, getBal(dst) + amt);
    if (taintModel === "FIFO") {
      const l = lots.get(dst) || [];
      l.push({ amt, dirty: false });   // clean by default...
      if (carried > 0) {
        // ...split the arriving lot into its dirty and clean parts
        l.pop();
        if (carried > 0) l.push({ amt: carried, dirty: true });
        if (amt - carried > 0.0001) l.push({ amt: amt - carried, dirty: false });
      }
      lots.set(dst, l);
    }

    if (carried >= minTaint) {
      pool.set(dst, (pool.get(dst) || 0) + carried);
      received.set(dst, (received.get(dst) || 0) + carried);
      if (!firstSeen.has(dst)) firstSeen.set(dst, ts);

      const d = (nodeDepth.get(src) ?? discDepth.get(src) ?? 0) + 1;
      if (!nodeDepth.has(dst) || nodeDepth.get(dst) > d) nodeDepth.set(dst, d);

      edges.push({
        txId: tx.id, from: src, to: dst,
        amount: amt, tainted: carried,
        ts: tx.ts, channel: tx.channel,
        hopSeconds: Math.round((ts - (firstSeen.get(src) ?? ts)) / 1000)
      });
    }
  }

  const nodes = [...received.entries()]
    .filter(([id, v]) => id === victimId || v >= minTaint)
    .map(([id, v]) => ({
      id,
      taintReceived: Math.round(v * 100) / 100,
      taintHeld: Math.round((pool.get(id) || 0) * 100) / 100,
      depth: nodeDepth.get(id) ?? discDepth.get(id) ?? null,
      firstSeen: firstSeen.get(id) ? new Date(firstSeen.get(id)) : null
    }))
    .sort((a, b) => a.depth - b.depth || b.taintReceived - a.taintReceived);

  const exited = exits.reduce((s, e) => s + e.tainted, 0);
  const stillHeld = nodes.reduce((s, n) => s + n.taintHeld, 0);

  return {
    nodes,
    edges,
    exits,
    stats: {
      candidatesScanned: ids.length,
      txnsScanned: txns.length,
      taintedNodes: nodes.length,
      taintedEdges: edges.length,
      amount: Number(amount),
      exited: Math.round(exited * 100) / 100,
      stillHeld: Math.round(stillHeld * 100) / 100,
      maxDepthReached: nodes.reduce((m, n) => Math.max(m, n.depth || 0), 0),
      elapsedMs: Date.now() - t0,
      taintModel
    }
  };
}
