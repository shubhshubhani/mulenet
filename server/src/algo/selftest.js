/**
 * Self-test — verifies the algorithms against hand-computed answers.
 *
 * Run:  node src/algo/selftest.js
 *
 * No database needed. This is the assertion suite referenced in the build plan:
 * if these pass, the core is correct and everything else is presentation.
 */
import { buildAndCut, blockedBySet } from "./maxflow.js";
import { knapsack, greedyByValue } from "./knapsack.js";
import { tarjanSCC, detectCommunities } from "./clusters.js";

let passed = 0, failed = 0;

function check(name, actual, expected, tol = 0.51) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}\n` +
    `        expected ${expected}   got ${actual}`
  );
  ok ? passed++ : failed++;
}

function checkSet(name, actual, expected) {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  const ok = a === e;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}\n` +
    `        expected [${e}]   got [${a}]`
  );
  ok ? passed++ : failed++;
}

console.log("\n  MuleNet algorithm self-test\n");

// ─────────────────────────────────────────────────────────────────────────
// Fixture: the exact worked example from the problem brief.
//
//   VICTIM 6.0L
//     -> M1 2.5L, M2 2.0L, M3 1.5L
//   M1 -> A 1.5L, B 1.0L
//   M2 -> B 1.2L, C 0.8L
//   M3 -> C 1.5L
//   A -> ATM 1.5L,  B -> CRYPTO 2.2L,  C -> ATM 2.3L
// ─────────────────────────────────────────────────────────────────────────
const L = 100000;

const trace = {
  nodes: [
    { id: 0, taintReceived: 6.0 * L, taintHeld: 0, depth: 0 },   // victim
    { id: 1, taintReceived: 2.5 * L, taintHeld: 0, depth: 1 },   // M1
    { id: 2, taintReceived: 2.0 * L, taintHeld: 0, depth: 1 },   // M2
    { id: 3, taintReceived: 1.5 * L, taintHeld: 0, depth: 1 },   // M3
    { id: 4, taintReceived: 1.5 * L, taintHeld: 0, depth: 2 },   // A
    { id: 5, taintReceived: 2.2 * L, taintHeld: 0, depth: 2 },   // B
    { id: 6, taintReceived: 2.3 * L, taintHeld: 0, depth: 2 }    // C
  ],
  edges: [
    { from: 0, to: 1, tainted: 2.5 * L }, { from: 0, to: 2, tainted: 2.0 * L },
    { from: 0, to: 3, tainted: 1.5 * L },
    { from: 1, to: 4, tainted: 1.5 * L }, { from: 1, to: 5, tainted: 1.0 * L },
    { from: 2, to: 5, tainted: 1.2 * L }, { from: 2, to: 6, tainted: 0.8 * L },
    { from: 3, to: 6, tainted: 1.5 * L }
  ],
  exits: [
    { from: 4, tainted: 1.5 * L }, { from: 5, tainted: 2.2 * L },
    { from: 6, tainted: 2.3 * L }
  ]
};

// ── 1. max-flow ──────────────────────────────────────────────────────────
console.log("  [1] Max-flow over the tainted subgraph");
const cut = buildAndCut(trace, 0);
check("all Rs 6.0L can reach the cash-out points", cut.maxFlow, 6.0 * L);

// ── 2. min-cut is a VERTEX cut (accounts, not transactions) ───────────────
console.log("\n  [2] Min-cut returns accounts, not edges");
console.log(`        cut set: ${cut.cutAccounts.map((c) => "#" + c.id).join(", ")}`);
const cutTotal = cut.cutAccounts.reduce((s, c) => s + c.blocked, 0);
check("cut capacity equals max flow", cutTotal, 6.0 * L);

// ── 3. blocked amounts are NOT additive ──────────────────────────────────
console.log("\n  [3] Verification by re-running the flow");
const freezeAll = blockedBySet(trace, 0, [1, 2, 3, 4, 5, 6]);
check("freezing every mule blocks everything", freezeAll.blocked, 6.0 * L);
check("nothing escapes", freezeAll.escapes, 0);

const layer1 = blockedBySet(trace, 0, [1, 2, 3]);
check("freezing layer 1 alone blocks everything", layer1.blocked, 6.0 * L);

const layer2 = blockedBySet(trace, 0, [4, 5, 6]);
check("freezing layer 2 alone also blocks everything", layer2.blocked, 6.0 * L);

// non-additivity: M1 (2.5L) + B (2.2L) naively sums to 4.7L, but freezing M1
// also cuts M1->B, so the true figure is lower
const m1b = blockedBySet(trace, 0, [1, 5]);
const naiveSum = 2.5 * L + 2.2 * L;
console.log(
  `\n        naive sum for {M1, B} = Rs ${(naiveSum / L).toFixed(1)}L\n` +
  `        verified by max-flow   = Rs ${(m1b.blocked / L).toFixed(1)}L`
);
const nonAdditive = m1b.blocked < naiveSum;
console.log(`  ${nonAdditive ? "PASS" : "FAIL"}  blocked amounts are not additive`);
nonAdditive ? passed++ : failed++;

// ── 4. knapsack vs greedy under a budget ─────────────────────────────────
console.log("\n  [4] Budget-constrained selection (budget = 100)");
const items = [
  { id: 1, value: 2.5 * L, cost: 70 },   // M1 — active salary account
  { id: 2, value: 2.0 * L, cost: 60 },
  { id: 3, value: 1.5 * L, cost: 55 },
  { id: 4, value: 1.5 * L, cost: 25 },   // A — dormant
  { id: 5, value: 2.2 * L, cost: 30 },   // B — dormant 11 months
  { id: 6, value: 2.3 * L, cost: 35 }    // C — dormant
];

const kn = knapsack(items, 100);
const gr = greedyByValue(items, 100);

console.log(`        knapsack picks ${kn.chosen.map((c) => "#" + c.id).join(", ")} (cost ${kn.cost})`);
console.log(`        greedy   picks ${gr.chosen.map((c) => "#" + c.id).join(", ")} (cost ${gr.cost})`);

checkSet("knapsack selects A, B, C", kn.chosen.map((c) => c.id), [4, 5, 6]);

const knV = blockedBySet(trace, 0, kn.chosen.map((c) => c.id));
const grV = blockedBySet(trace, 0, gr.chosen.map((c) => c.id));

console.log(
  `\n        knapsack verified blocked: Rs ${(knV.blocked / L).toFixed(2)}L\n` +
  `        greedy   verified blocked: Rs ${(grV.blocked / L).toFixed(2)}L`
);
check("knapsack blocks the full Rs 6.0L", knV.blocked, 6.0 * L);

const beatsGreedy = knV.blocked > grV.blocked;
console.log(`  ${beatsGreedy ? "PASS" : "FAIL"}  knapsack beats greedy at the same budget` +
            `\n        advantage Rs ${((knV.blocked - grV.blocked) / L).toFixed(2)}L`);
beatsGreedy ? passed++ : failed++;

check("knapsack stays within budget", kn.cost <= 100 ? 1 : 0, 1);

// ── 5. the victim is never frozen ────────────────────────────────────────
console.log("\n  [5] Safety invariants");
const victimInCut = cut.cutAccounts.some((c) => c.id === 0);
console.log(`  ${!victimInCut ? "PASS" : "FAIL"}  victim is never in the freeze set`);
!victimInCut ? passed++ : failed++;

// ── 6. Tarjan SCC finds circular layering ────────────────────────────────
console.log("\n  [6] Circular layering (Tarjan SCC)");
const cyclic = {
  nodes: trace.nodes,
  edges: [...trace.edges, { from: 5, to: 1, tainted: 0.3 * L }]  // B loops back to M1
};
const comps = tarjanSCC(cyclic.nodes.map((n) => n.id), cyclic.edges);
console.log(`        components: ${JSON.stringify(comps)}`);
check("one loop detected", comps.length, 1, 0);
checkSet("loop is M1 -> B -> M1", comps[0] || [], [1, 5]);

const noLoop = tarjanSCC(trace.nodes.map((n) => n.id), trace.edges);
check("acyclic trail reports no loops", noLoop.length, 0, 0);

// ── 7. communities ───────────────────────────────────────────────────────
console.log("\n  [7] Operator clustering");
const fm = new Map(trace.nodes.map((n) => [
  n.id, { bank: n.id <= 3 ? "HDFC" : "SBIN", city: "Kolkata" }
]));
const ops = detectCommunities(
  trace.nodes.map((n) => n.id),
  trace.edges.map((e) => ({ ...e, hopSeconds: 120 })),
  fm
);
console.log(`        ${ops.length} cluster(s): ${ops.map((o) => `${o.id}(${o.size})`).join(", ")}`);
const clustered = ops.length >= 1 && ops[0].size > 1;
console.log(`  ${clustered ? "PASS" : "FAIL"}  accounts grouped into operator clusters`);
clustered ? passed++ : failed++;

// ── 8. empty input does not crash ────────────────────────────────────────
console.log("\n  [8] Degenerate input");
const empty = buildAndCut({ nodes: [], edges: [], exits: [] }, 0);
check("empty trace yields zero flow", empty.maxFlow, 0);
check("empty knapsack yields nothing", knapsack([], 100).chosen.length, 0, 0);

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
