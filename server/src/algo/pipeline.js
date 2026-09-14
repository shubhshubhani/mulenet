/**
 * Case pipeline — runs every algorithm in order and assembles one answer.
 *
 *   1. time-respecting traversal + taint   (traversal.js)
 *   2. behavioural features + action cost  (features.js)
 *   3. max-flow / min-cut freeze set       (maxflow.js)
 *   4. budget-constrained selection        (knapsack.js)
 *   5. circular layering + operator groups (clusters.js)
 *
 * Everything the API and the UI need comes out of here in one shape.
 */
import { traceTaint } from "./traversal.js";
import { computeFeatures, geoVelocity } from "./features.js";
import { buildAndCut, blockedBySet } from "./maxflow.js";
import { knapsack, greedyByValue } from "./knapsack.js";
import { tarjanSCC, detectCommunities } from "./clusters.js";
import { q } from "../db.js";

export async function runCase({
  victimId,
  fraudTs,
  amount,
  maxDepth = 6,
  taintModel = "PRORATA",
  budget = 60
}) {
  const started = Date.now();

  // ── 1. trace ───────────────────────────────────────────────────────────
  const trace = await traceTaint({
  victimId, fraudTs, amount, maxDepth, taintModel,
  minTaint: Math.max(500, Number(amount) * 0.01)   // ignore <1% dust
});
  if (!trace.nodes.length) {
    return {
      trace, features: [], cut: { maxFlow: 0, cutAccounts: [] },
      plan: null, cycles: [], operators: [],
      summary: { amount: Number(amount), traced: 0, exited: 0 },
      elapsedMs: Date.now() - started
    };
  }

  const ids = trace.nodes.map((n) => n.id);

  // ── 2. features ────────────────────────────────────────────────────────
  const featureMap = await computeFeatures(ids, fraudTs);
  const edgesGeo = geoVelocity(trace.edges, featureMap);

  const accts = await q(
    `SELECT id, acct_no, bank_code, ifsc, city, lat, lon, opened_at, kyc_level
       FROM accounts WHERE id = ANY($1::int[])`,
    [ids]
  );
  const acctById = new Map(accts.map((a) => [a.id, a]));

  // ── 3. min-cut ─────────────────────────────────────────────────────────
  const cut = buildAndCut(trace, victimId);

  // ── 4. knapsack over the cut candidates ────────────────────────────────
  // Candidates: the min-cut accounts, plus any other high-taint node, so the DP
  // has room to trade a big expensive account for two cheap ones.
  const candIds = new Set(cut.cutAccounts.map((c) => c.id));
  for (const n of trace.nodes) {
    if (n.id !== victimId && n.taintReceived > 0) candIds.add(n.id);
  }

  const items = [...candIds].map((id) => {
    const node = trace.nodes.find((n) => n.id === id);
    const f = featureMap.get(id);
    return {
      id,
      value: node ? node.taintReceived : 0,
      cost: f ? f.actionCost : 50
    };
  }).filter((it) => it.value > 0);

  const kn = knapsack(items, budget);
  const gr = greedyByValue(items, budget);

  // Blocked amounts are not additive, so both plans are verified by re-running
  // the flow with those accounts removed.
  const knVerified = blockedBySet(trace, victimId, kn.chosen.map((c) => c.id));
  const grVerified = blockedBySet(trace, victimId, gr.chosen.map((c) => c.id));
  const cutVerified = blockedBySet(trace, victimId, cut.cutAccounts.map((c) => c.id));

  // ── 5. structure ───────────────────────────────────────────────────────
  const cycles = tarjanSCC(ids, trace.edges);
  const operators = detectCommunities(ids, trace.edges, featureMap);

  // ── assemble ───────────────────────────────────────────────────────────
  const nodes = trace.nodes.map((n) => {
    const a = acctById.get(n.id);
    const f = featureMap.get(n.id) || {};
    return {
      ...n,
      acctNo: a ? a.acct_no : null,
      bank: a ? a.bank_code : null,
      ifsc: a ? a.ifsc : null,
      city: a ? a.city : null,
      lat: a ? Number(a.lat) : null,
      lon: a ? Number(a.lon) : null,
      riskScore: f.riskScore ?? null,
      actionCost: f.actionCost ?? null,
      ageDays: f.ageDays ?? null,
      dormancyDays: f.dormancyDays ?? null,
      retention: f.retention ?? null,
      extCredits: f.extCredits ?? null,
      isVictim: n.id === victimId,
      inCut: candIdsHas(cut.cutAccounts, n.id),
      inPlan: kn.chosen.some((c) => c.id === n.id),
      operator: (operators.find((o) => o.members.includes(n.id)) || {}).id || null
    };
  });

  return {
    victimId,
    fraudTs,
    amount: Number(amount),
    nodes,
    edges: edgesGeo,
    exits: trace.exits,
    stats: trace.stats,
    cut: {
      maxFlow: cut.maxFlow,
      accounts: cut.cutAccounts,
      verified: cutVerified
    },
    plan: {
      budget,
      knapsack: {
        chosen: kn.chosen,
        heuristicValue: kn.value,
        cost: kn.cost,
        verified: knVerified
      },
      greedy: {
        chosen: gr.chosen,
        heuristicValue: gr.value,
        cost: gr.cost,
        verified: grVerified
      },
      advantage: Math.round((knVerified.blocked - grVerified.blocked) * 100) / 100
    },
    cycles,
    operators,
    summary: {
      amount: Number(amount),
      tracedNodes: nodes.length,
      tracedEdges: edgesGeo.length,
      exited: trace.stats.exited,
      stillHeld: trace.stats.stillHeld,
      maxDepth: trace.stats.maxDepthReached,
      recoverable: knVerified.blocked,
      operators: operators.length,
      cycles: cycles.length
    },
    elapsedMs: Date.now() - started
  };
}

function candIdsHas(list, id) {
  return list.some((c) => c.id === id);
}
