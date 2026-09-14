import React from "react";
import { api, inr, timeOf } from "../api.js";

/**
 * Detail view for one account on the trail.
 *
 * The ground-truth block at the bottom is shown ONLY because this is a demo on
 * simulated data — it is how you prove to a judge that the detector was right
 * without the detector ever having seen the label.
 */
export default function AccountPanel({ accountId, result, onClose }) {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    if (!accountId) return;
    setData(null); setErr("");
    api.account(accountId).then(setData).catch((e) => setErr(e.message));
  }, [accountId]);

  if (!accountId) return null;

  const node = result?.nodes?.find((n) => n.id === accountId);

  return (
    <div className="card">
      <div className="row">
        <div>
          <h2>Account #{accountId}</h2>
          <div className="sub">
            {data?.account
              ? `${data.account.bank_code} · ${data.account.city} · ${data.account.ifsc}`
              : "loading…"}
          </div>
        </div>
        <div className="spacer" />
        {node?.inPlan && <span className="pill good">recommended freeze</span>}
        {node?.inCut && !node?.inPlan && <span className="pill warn">in min-cut</span>}
        <button className="ghost xs" onClick={onClose}>close</button>
      </div>

      {err && <div className="banner err">{err}</div>}

      {node && (
        <div className="grid-4" style={{ marginBottom: 10 }}>
          <div className="tile">
            <div className="k">TAINT RECEIVED</div>
            <div className="v" style={{ fontSize: 16 }}>{inr(node.taintReceived)}</div>
          </div>
          <div className="tile">
            <div className="k">STILL HELD</div>
            <div className="v green" style={{ fontSize: 16 }}>{inr(node.taintHeld)}</div>
          </div>
          <div className="tile">
            <div className="k">RISK</div>
            <div className="v" style={{ fontSize: 16 }}>{node.riskScore}<span style={{ fontSize: 11 }}>/100</span></div>
          </div>
          <div className="tile">
            <div className="k">FREEZE COST</div>
            <div className="v" style={{ fontSize: 16 }}>{node.actionCost}</div>
          </div>
        </div>
      )}

      {data?.features && (
        <table style={{ marginBottom: 10 }}>
          <tbody>
            <Row k="Account age" v={`${data.features.ageDays} days`} />
            <Row k="Dormant before this case" v={`${data.features.dormancyDays} days`} />
            <Row k="External credits (salary etc.)" v={data.features.extCredits} />
            <Row k="Retention ratio"
                 v={data.features.retention}
                 note={data.features.retention < 0.08 ? "near-zero — pass-through" : null} />
            <Row k="Transactions per day" v={data.features.txPerDay} />
            <Row k="Distinct counterparties" v={data.features.counterparties} />
            <Row k="Cash exits" v={data.features.cashExits} />
            <Row k="KYC level" v={data.account?.kyc_level} />
          </tbody>
        </table>
      )}

      {data?.recent?.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>
            Recent activity
          </div>
          <table>
            <thead>
              <tr>
                <th>When</th><th>Direction</th>
                <th className="num">Amount</th><th>Channel</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.slice(0, 12).map((t) => {
                const out = t.src === accountId;
                return (
                  <tr key={t.id}>
                    <td style={{ color: "var(--muted)" }}>{timeOf(t.ts)}</td>
                    <td>
                      {out
                        ? <span style={{ color: "var(--danger)" }}>
                            → {t.dst === null ? "cash-out" : `#${t.dst}`}
                          </span>
                        : <span style={{ color: "var(--accent)" }}>
                            ← {t.src === null ? "external" : `#${t.src}`}
                          </span>}
                    </td>
                    <td className="num">{inr(t.amount)}</td>
                    <td style={{ color: "var(--muted)" }}>{t.channel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {data?.groundTruth && (
        <div className="banner" style={{ marginTop: 10 }}>
          <b>Ground truth (simulator only).</b> This account{" "}
          {data.groundTruth.is_mule
            ? <span style={{ color: "var(--danger)" }}>was a planted mule</span>
            : <span style={{ color: "var(--accent)" }}>was not part of any ring</span>}
          {data.groundTruth.is_cashout && " and was a cash-out point"}.
          The detector never reads this field — it is here so you can check the
          answer.
        </div>
      )}
    </div>
  );
}

function Row({ k, v, note }) {
  return (
    <tr>
      <td style={{ color: "var(--muted)" }}>{k}</td>
      <td className="num"><b>{v}</b></td>
      <td style={{ color: "var(--warn)", fontSize: 11.5 }}>{note}</td>
    </tr>
  );
}
