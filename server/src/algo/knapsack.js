/**
 * Budget-constrained freeze selection — 0/1 knapsack DP.
 *
 * Min-cut gives the theoretically optimal freeze set. Reality intrudes in two
 * ways:
 *
 *   1. An investigator can only action a limited number of accounts per shift.
 *   2. Each freeze carries a different false-positive cost. Freezing an account
 *      that has been dormant for 11 months and suddenly spiked is cheap.
 *      Freezing someone's active salary account is expensive — a real person
 *      loses access to their own money while the investigation runs.
 *
 * So the real problem is:
 *
 *      maximise    sum of tainted rupees blocked
 *      subject to  sum of action costs <= budget
 *
 * which is 0/1 knapsack.  O(n * budget), with the chosen set reconstructed by
 * walking the DP table back.
 *
 * IMPORTANT CAVEAT, and the reason this file does not stand alone:
 * blocked amounts are NOT additive. Freezing an upstream mule also reduces what
 * flows to the ones beneath it, so summing per-account figures double-counts.
 * The DP therefore uses per-account taint as a RANKING HEURISTIC only; the
 * chosen set is then verified exactly by re-running max-flow in
 * maxflow.blockedBySet(). Knapsack proposes, max-flow verifies.
 */

/**
 * @param {Array<{id:number, value:number, cost:number}>} items
 * @param {number} budget  integer units of investigator effort
 */
export function knapsack(items, budget) {
  const n = items.length;
  const B = Math.max(0, Math.floor(budget));
  if (!n || B === 0) return { chosen: [], value: 0, cost: 0 };

  // scale values to integers (paise -> whole rupees is plenty)
  const w = items.map((it) => Math.max(1, Math.round(it.cost)));
  const v = items.map((it) => Math.max(0, it.value));

  // dp[b] = best value achievable with budget exactly <= b
  const dp = new Float64Array(B + 1);
  // keep[i][b] = was item i taken at budget b  (bitset per row to stay small)
  const keep = Array.from({ length: n }, () => new Uint8Array(B + 1));

  for (let i = 0; i < n; i++) {
    const wi = w[i], vi = v[i];
    // iterate downwards so each item is used at most once
    for (let b = B; b >= wi; b--) {
      const cand = dp[b - wi] + vi;
      if (cand > dp[b] + 1e-9) {
        dp[b] = cand;
        keep[i][b] = 1;
      }
    }
  }

  // reconstruct
  const chosen = [];
  let b = B;
  for (let i = n - 1; i >= 0; i--) {
    if (keep[i][b]) {
      chosen.push(items[i]);
      b -= w[i];
    }
  }
  chosen.reverse();

  return {
    chosen,
    value: Math.round(dp[B] * 100) / 100,
    cost: chosen.reduce((s, it) => s + Math.round(it.cost), 0)
  };
}

/**
 * The naive baseline we compare against in the demo: take the biggest blocked
 * amount first until the budget runs out. It looks reasonable and is measurably
 * worse, which is exactly the point.
 */
export function greedyByValue(items, budget) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const chosen = [];
  let spent = 0;
  for (const it of sorted) {
    const c = Math.max(1, Math.round(it.cost));
    if (spent + c <= budget) { chosen.push(it); spent += c; }
  }
  return {
    chosen,
    value: Math.round(chosen.reduce((s, i) => s + i.value, 0) * 100) / 100,
    cost: spent
  };
}
