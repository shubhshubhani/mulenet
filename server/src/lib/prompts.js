/**
 * Every prompt in one reviewable place.
 *
 * The LLM has exactly three jobs in this system, and none of them is "decide
 * the answer":
 *
 *   1. INTAKE       — turn a victim's narrative complaint into structured fields.
 *   2. EXPLANATION  — turn a flagged subgraph into a justification an
 *                     investigator can act on and a court can read. A freeze
 *                     that cannot be justified is a freeze that gets litigated,
 *                     so this is a compliance requirement, not a convenience.
 *   3. INVESTIGATION — answer natural-language questions about a case, strictly
 *                     from the computed evidence.
 *
 * The model never picks which accounts to freeze and never invents a rupee
 * figure. Those come from max-flow and knapsack. This separation is the whole
 * design.
 */

export const SYSTEM_EXPLAIN = `
You are the explanation layer of a financial-crime tracing system used by bank
fraud investigators in India.

You are given the OUTPUT of a deterministic analysis: a traced money trail, the
tainted amounts at each hop, and a recommended set of accounts to freeze that
was computed by a min-cut and a knapsack solver.

Your job is to explain that result. Your job is NOT to change it.

Hard rules:
- Never invent an account, an amount, a timestamp or a bank. Use only what is
  in the evidence block.
- Never suggest freezing an account that is not in the recommended set, and
  never argue against one that is.
- Quote the concrete signals: dormancy, hop timing, geographic distance,
  absence of salary credits, retention ratio.
- Write for a working investigator: plain, specific, unhedged. No preamble.
- Amounts in Indian format (Rs 4,20,000). Times as given.
- Be brief. Six sentences at most unless asked for more.
`.trim();

export const SYSTEM_INTAKE = `
You extract structured fields from a cyber-fraud victim's complaint, written in
English, Hindi, Bengali or a mix. You only extract. You never judge, advise or
estimate.
`.trim();

export const SYSTEM_QUERY = `
You answer an investigator's questions about ONE traced fraud case, using only
the evidence block provided. If the answer is not in the evidence, say so
plainly rather than guessing. Be concise and concrete.
`.trim();

/** Compact evidence block — keeps the prompt small and the answers grounded. */
export function evidenceBlock(result, limit = 22) {
  const inr = (n) =>
    "Rs " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  const victim = result.nodes.find((n) => n.isVictim);
  const top = [...result.nodes]
    .filter((n) => !n.isVictim)
    .sort((a, b) => b.taintReceived - a.taintReceived)
    .slice(0, limit);

  const nodeLines = top.map((n) =>
    `  #${n.id} ${n.bank} ${n.city} | depth ${n.depth} | received ${inr(n.taintReceived)} | ` +
    `still held ${inr(n.taintHeld)} | risk ${n.riskScore}/100 | freeze cost ${n.actionCost} | ` +
    `age ${n.ageDays}d | dormant ${n.dormancyDays}d | retention ${n.retention} | ` +
    `salary credits ${n.extCredits}` +
    (n.operator ? ` | operator ${n.operator}` : "") +
    (n.inPlan ? " | RECOMMENDED FOR FREEZE" : "")
  ).join("\n");

  const fastHops = result.edges
    .filter((e) => (e.hopSeconds ?? 9999) < 900)
    .slice(0, 12)
    .map((e) =>
      `  #${e.from} -> #${e.to} ${inr(e.tainted)} after ${e.hopSeconds}s` +
      (e.km != null ? `, ${e.km} km apart` : "") +
      (e.implausible ? " [geographically implausible]" : ""))
    .join("\n");

  const exitLines = result.exits.slice(0, 10).map((x) =>
    `  #${x.from} ${x.channel} ${inr(x.tainted)} at ${new Date(x.ts).toISOString()}`
  ).join("\n");

  const plan = result.plan?.knapsack;
  const planLines = plan
    ? plan.chosen.map((c) => `  #${c.id} blocks ${inr(c.value)} at cost ${c.cost}`).join("\n")
    : "  (none)";

  return `
=== CASE ===
Victim account: #${result.victimId} (${victim?.bank || "?"}, ${victim?.city || "?"})
Amount defrauded: ${inr(result.amount)}
Fraud time: ${new Date(result.fraudTs).toISOString()}
Taint model: ${result.stats?.taintModel}
Traced: ${result.summary.tracedNodes} accounts, ${result.summary.tracedEdges} transfers, max depth ${result.summary.maxDepth}
Already exited the banking system: ${inr(result.summary.exited)}
Still sitting in accounts: ${inr(result.summary.stillHeld)}
Distinct operator clusters: ${result.summary.operators}
Circular layering loops found: ${result.summary.cycles}

=== ACCOUNTS ON THE TRAIL ===
${nodeLines || "  (none)"}

=== RAPID HOPS ===
${fastHops || "  (none)"}

=== CASH-OUT POINTS ===
${exitLines || "  (none)"}

=== RECOMMENDED FREEZE SET (computed by min-cut + knapsack) ===
Budget: ${result.plan?.budget} units of investigator action
${planLines}
Verified by re-running max flow: blocks ${inr(plan?.verified?.blocked)} of ${inr(plan?.verified?.baseline)} still in motion
Greedy baseline would block only ${inr(result.plan?.greedy?.verified?.blocked)}
`.trim();
}

export function explainPrompt(result) {
  return `
${evidenceBlock(result)}

Write the investigator briefing for this case. Cover, in this order:
1. What happened to the money, in two or three sentences.
2. Why the recommended accounts were selected — cite the specific behavioural
   signals for at least two of them.
3. What is still recoverable and what has already gone.

Then add one short line headed "If challenged:" giving the strongest factual
justification for the freeze, in case the account holder disputes it.
`.trim();
}

export function intakePrompt(narrative) {
  return `
Extract the fraud details from this complaint.

Return EXACTLY this JSON and nothing else:
{
  "amount": 0,
  "fraud_time_hint": "",
  "channel": "UPI|IMPS|NEFT|CARD|UNKNOWN",
  "playbook": "DIGITAL_ARREST|INVESTMENT|JOB_OFFER|KYC_UPDATE|LOTTERY|ROMANCE|OTP_THEFT|OTHER",
  "counterparty_hint": "",
  "summary": ""
}

Rules:
- "amount" is the rupee figure the victim lost, as a plain number. 0 if absent.
- "fraud_time_hint" is whatever the victim said about timing, verbatim-ish
  ("last night around 9", "kal raat"). Empty string if absent.
- "playbook" is the scam pattern. DIGITAL_ARREST is when the caller impersonated
  police, CBI, customs or a courier company and kept the victim on a call.
- "summary" is one neutral factual sentence. No advice, no sympathy, no blame.

COMPLAINT:
"""
${narrative}
"""
`.trim();
}

export function queryPrompt(result, question) {
  return `
${evidenceBlock(result, 30)}

INVESTIGATOR'S QUESTION:
${question}
`.trim();
}
