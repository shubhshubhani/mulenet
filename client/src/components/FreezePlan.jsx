import React from "react";
import { api, inr, inrShort } from "../api.js";
import {
  REGISTRY_ADDRESS, submitFlags, logFreezeRequest, queryFlag, explorerTx
} from "../chain.js";

/**
 * The freeze plan — the money shot of the demo.
 *
 * Shows three strategies side by side, all verified the same way (re-run the
 * flow with those accounts removed and measure what still escapes), because
 * blocked amounts are NOT additive across accounts.
 */
export default function FreezePlan({ result, wallet, onSelect, selected, notify }) {
  const [busy, setBusy] = React.useState(false);
  const [txHash, setTxHash] = React.useState(null);
  const [lookup, setLookup] = React.useState(null);

  if (!result?.plan) return null;

  const { plan, cut, nodes } = result;
  const kn = plan.knapsack, gr = plan.greedy;
  const baseline = kn.verified.baseline || 1;

  const nodeOf = (id) => nodes.find((n) => n.id === id);

  const push = async () => {
    if (!wallet || !REGISTRY_ADDRESS) return;
    setBusy(true);
    try {
      const prep = await api.prepareFlags({
        case_id: result.caseId,
        account_ids: kn.chosen.map((c) => c.id),
        summary: result.summary
      });

      const tx = await submitFlags({
        signer: wallet.signer,
        accountHashes: prep.submissions.map((s) => s.accountHash),
        evidenceHash: prep.caseHash,
        severity: 3
      });
      setTxHash(tx);

      await logFreezeRequest({ signer: wallet.signer, caseHash: prep.caseHash })
        .catch(() => {});

      for (const s of prep.submissions) {
        await api.recordFlag({
          case_id: result.caseId, account_id: s.accountId, chain_tx: tx
        }).catch(() => {});
      }
      notify(`${prep.submissions.length} flags submitted to the shared registry.`, "ok");
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** The cross-bank beat: another bank checks a hash and learns nothing else. */
  const checkAsOtherBank = async () => {
    if (!wallet || !REGISTRY_ADDRESS || !kn.chosen.length) return;
    setBusy(true);
    try {
      const prep = await api.prepareFlags({
        case_id: result.caseId,
        account_ids: [kn.chosen[0].id],
        summary: {}
      });
      const hash = prep.submissions[0].accountHash;
      const onChain = await queryFlag({ signer: wallet.signer, accountHash: hash });
      setLookup({ hash, ...onChain });
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  const Strategy = ({ title, chosen, verified, cost, tone, note }) => {
    const pctv = Math.min(100, (verified.blocked / baseline) * 100);
    return (
      <div style={{ marginBottom: 13 }}>
        <div className="row" style={{ marginBottom: 5 }}>
          <strong style={{ fontSize: 12.5 }}>{title}</strong>
          <span className="pill">{chosen.length} accounts &middot; cost {cost}</span>
          <div className="spacer" />
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{note}</span>
        </div>
        <div className="bar-track">
          <div className="bar-fill"
               style={{
                 width: `${pctv}%`,
                 background: tone === "good" ? "var(--accent)"
                           : tone === "bad" ? "#fca5a5" : "var(--blue)"
               }} />
          <span className="bar-label">
            {inr(verified.blocked)} blocked &middot; {pctv.toFixed(0)}%
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="card">
      <div className="row">
        <div>
          <h2>Freeze plan</h2>
          <div className="sub">
            Min-cut finds the optimal set. Knapsack fits it to what an
            investigator can actually action this shift.
          </div>
        </div>
        <div className="spacer" />
        <span className="pill info">budget {plan.budget}</span>
      </div>

      <Strategy
        title="Min-cut (no budget limit)"
        chosen={cut.accounts} verified={cut.verified} cost="—" tone="blue"
        note="theoretical optimum" />

      <Strategy
        title="Knapsack DP (within budget)"
        chosen={kn.chosen} verified={kn.verified} cost={kn.cost} tone="good"
        note="what we recommend" />

      <Strategy
        title="Greedy by amount (baseline)"
        chosen={gr.chosen} verified={gr.verified} cost={gr.cost} tone="bad"
        note="the obvious approach" />

      {plan.advantage > 0 && (
        <div className="banner ok" style={{ marginTop: 4 }}>
          Knapsack blocks <b>{inr(plan.advantage)} more</b> than greedy at the
          same budget — greedy spends it all on one expensive account.
        </div>
      )}

      <table style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Account</th><th>Bank / city</th>
            <th className="num">Blocks</th>
            <th className="num">Cost</th>
            <th className="num">Risk</th>
            <th>Why it is cheap to freeze</th>
          </tr>
        </thead>
        <tbody>
          {kn.chosen.map((c) => {
            const n = nodeOf(c.id) || {};
            const reasons = [];
            if (n.extCredits === 0) reasons.push("no salary credits");
            if (n.retention != null && n.retention < 0.08) reasons.push("pass-through");
            if (n.dormancyDays > 45) reasons.push(`dormant ${Math.round(n.dormancyDays)}d`);
            if (n.ageDays < 120) reasons.push(`opened ${n.ageDays}d ago`);
            return (
              <tr key={c.id}
                  className={`clickable ${selected === c.id ? "hl" : ""}`}
                  onClick={() => onSelect && onSelect(c.id)}>
                <td><b>#{c.id}</b></td>
                <td style={{ color: "var(--muted)" }}>{n.bank} &middot; {n.city}</td>
                <td className="num" style={{ color: "var(--accent)" }}>
                  {inrShort(c.value)}
                </td>
                <td className="num">{c.cost}</td>
                <td className="num">{n.riskScore}</td>
                <td style={{ color: "var(--muted)", fontSize: 11.5 }}>
                  {reasons.join(", ") || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {wallet && REGISTRY_ADDRESS && (
        <div style={{ marginTop: 13, borderTop: "1px solid var(--line)", paddingTop: 11 }}>
          <div className="row">
            <button className="violet sm" onClick={push} disabled={busy}>
              {busy ? "submitting…" : "Submit flags to shared registry"}
            </button>
            <button className="ghost sm" onClick={checkAsOtherBank} disabled={busy}>
              Check as another bank
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>
            Only salted hashes are written on-chain. No account number, holder
            identifier or IFSC ever leaves this service.
          </div>

          {txHash && (
            <div className="mono" style={{ marginTop: 6 }}>
              {explorerTx(txHash)
                ? <a href={explorerTx(txHash)} target="_blank" rel="noreferrer">
                    view transaction {txHash.slice(0, 18)}…
                  </a>
                : `tx ${txHash.slice(0, 24)}…`}
            </div>
          )}

          {lookup && (
            <div className="banner" style={{ marginTop: 8 }}>
              <b>Cross-bank lookup.</b> A second bank hashes an account number it
              already holds and asks the registry:
              <div className="mono" style={{ margin: "5px 0" }}>{lookup.hash}</div>
              {lookup.known
                ? <>Result: <b style={{ color: "var(--warn)" }}>
                    already flagged by {lookup.flagCount} member(s), severity {lookup.severity}
                  </b> — learned without either bank disclosing a customer.</>
                : <>Result: not yet flagged. Submit the plan first, then re-check.</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
