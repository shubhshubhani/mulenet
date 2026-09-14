import React from "react";
import { api, inr, timeOf } from "../api.js";

const SAMPLE_NARRATIVE =
  "Yesterday a call came saying they are from CBI Mumbai and a parcel in my " +
  "name had drugs. They kept me on video call for two hours and said do not " +
  "tell anyone in the family. They made me transfer 4,20,000 from my account " +
  "through UPI for verification. Now the number is switched off.";

/**
 * Case entry.
 *
 * Two ways in, both real:
 *   1. Pick an injected ring — instant, reproducible, what you demo from.
 *   2. Paste a victim's complaint in plain language and let the model extract
 *      the amount, the timing and the scam playbook. Complaints arrive as
 *      narrative, not as form fields, so this is not a gimmick.
 */
export default function CaseRunner({ onResult, notify, busy, setBusy }) {
  const [rings, setRings] = React.useState([]);
  const [ringId, setRingId] = React.useState("");
  const [mode, setMode] = React.useState("ring");

  const [victimId, setVictimId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [fraudTs, setFraudTs] = React.useState("");

  const [maxDepth, setMaxDepth] = React.useState(6);
  const [budget, setBudget] = React.useState(60);
  const [taintModel, setTaintModel] = React.useState("PRORATA");

  const [narrative, setNarrative] = React.useState(SAMPLE_NARRATIVE);
  const [extracted, setExtracted] = React.useState(null);

  React.useEffect(() => {
    api.rings().then((r) => {
      setRings(r);
      if (r.length) selectRing(r[0], true);
    }).catch((e) => notify(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRing(ring, quiet) {
    setRingId(String(ring.id));
    setVictimId(String(ring.victim_id));
    setAmount(String(Math.round(Number(ring.amount))));
    setFraudTs(new Date(ring.fraud_ts).toISOString().slice(0, 16));
    if (!quiet) setExtracted(null);
  }

  const run = async () => {
    if (!victimId || !amount || !fraudTs) {
      notify("Need a victim account, an amount and a time.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.trace({
        victim_id: Number(victimId),
        amount: Number(amount),
        fraud_ts: new Date(fraudTs).toISOString(),
        max_depth: Number(maxDepth),
        budget: Number(budget),
        taint_model: taintModel
      });
      if (!res.nodes?.length) {
        notify("Nothing traced — no outgoing transfers after that timestamp.");
      }
      onResult(res);
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doIntake = async () => {
    setBusy(true);
    try {
      const res = await api.intake({
        narrative,
        victim_id: victimId ? Number(victimId) : null,
        fraud_ts: fraudTs ? new Date(fraudTs).toISOString() : null
      });
      setExtracted(res.extracted);
      if (res.extracted?.amount) setAmount(String(res.extracted.amount));
      notify(
        `Extracted ${inr(res.extracted?.amount)} · ${res.extracted?.playbook}` +
        (res.grounded ? "" : " (offline extraction)"),
        "ok"
      );
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row">
        <div>
          <h2>New case</h2>
          <div className="sub">
            Trace where the money went, then compute what to freeze.
          </div>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          <button className={mode === "ring" ? "sm" : "ghost sm"}
                  onClick={() => setMode("ring")}>Injected ring</button>
          <button className={mode === "narrative" ? "sm" : "ghost sm"}
                  onClick={() => setMode("narrative")}>Victim complaint</button>
        </div>
      </div>

      {mode === "ring" && (
        <>
          <label>Reported fraud</label>
          <select
            value={ringId}
            onChange={(e) => {
              const r = rings.find((x) => String(x.id) === e.target.value);
              if (r) selectRing(r);
            }}>
            {rings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} · victim #{r.victim_id} ({r.bank_code}, {r.city}) ·{" "}
                {inr(r.amount)} · {timeOf(r.fraud_ts)} · {r.mules} mules
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 5 }}>
            Mule count shown is ground truth from the simulator — the detector
            never sees it.
          </div>
        </>
      )}

      {mode === "narrative" && (
        <>
          <label>Victim&apos;s complaint, in their own words</label>
          <textarea value={narrative} rows={5}
                    onChange={(e) => setNarrative(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="blue sm" onClick={doIntake} disabled={busy}>
              {busy ? "reading…" : "Extract details"}
            </button>
            {extracted && (
              <>
                <span className="pill info">{extracted.playbook}</span>
                <span className="pill">{inr(extracted.amount)}</span>
                {extracted.fraud_time_hint && (
                  <span className="pill">&ldquo;{extracted.fraud_time_hint}&rdquo;</span>
                )}
              </>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>
            Complaints arrive as narrative in mixed languages. Set the victim
            account below, then run the trace.
          </div>
        </>
      )}

      <div className="grid-3" style={{ marginTop: 4 }}>
        <div>
          <label>Victim account id</label>
          <input value={victimId} onChange={(e) => setVictimId(e.target.value)} />
        </div>
        <div>
          <label>Amount (Rs)</label>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label>Fraud time</label>
          <input type="datetime-local" value={fraudTs}
                 onChange={(e) => setFraudTs(e.target.value)} />
        </div>
      </div>

      <div className="grid-3">
        <div>
          <label>Max depth</label>
          <input type="number" value={maxDepth} min="1" max="10"
                 onChange={(e) => setMaxDepth(e.target.value)} />
        </div>
        <div>
          <label>Investigator budget</label>
          <input type="number" value={budget} min="10" max="400"
                 onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div>
          <label>Taint model</label>
          <select value={taintModel} onChange={(e) => setTaintModel(e.target.value)}>
            <option value="PRORATA">Pro-rata</option>
            <option value="FIFO">FIFO (first in, first out)</option>
          </select>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={run} disabled={busy}>
          {busy ? <><span className="spin">◐</span> tracing…</> : "Trace the money"}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>
          Time-respecting traversal → taint attribution → min-cut → knapsack
        </span>
      </div>
    </div>
  );
}
