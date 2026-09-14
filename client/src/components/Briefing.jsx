import React from "react";
import { api } from "../api.js";

const SUGGESTIONS = [
  "Which account should I freeze first and why?",
  "How much has already left the banking system?",
  "Is there any evidence these accounts are run by one operator?",
  "What would I tell the account holder if they dispute the freeze?"
];

/**
 * Investigator briefing.
 *
 * The LLM's job here is explanation, not decision. It never picks accounts and
 * never invents a rupee figure — every number it cites was computed by the
 * min-cut and knapsack solvers and handed to it in the evidence block. A freeze
 * that cannot be justified is a freeze that gets litigated, which is why this
 * panel exists at all.
 */
export default function Briefing({ result, notify }) {
  const [text, setText] = React.useState("");
  const [grounded, setGrounded] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [qa, setQa] = React.useState([]);
  const [question, setQuestion] = React.useState("");
  const [asking, setAsking] = React.useState(false);

  React.useEffect(() => { setText(""); setQa([]); setGrounded(null); }, [result?.caseId]);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.explain(result);
      setText(res.text);
      setGrounded(res.grounded);
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  const ask = async (qtext) => {
    const question_ = (qtext ?? question).trim();
    if (!question_) return;
    setQuestion("");
    setAsking(true);
    setQa((prev) => [...prev, { role: "user", text: question_ }]);
    try {
      const res = await api.ask(result, question_);
      setQa((prev) => [...prev, { role: "assistant", text: res.text }]);
    } catch (e) {
      notify(e.message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="card">
      <div className="row">
        <div>
          <h2>Investigator briefing</h2>
          <div className="sub">
            Generated from the computed result. The model explains the decision;
            it does not make it.
          </div>
        </div>
        <div className="spacer" />
        {grounded === false && <span className="pill warn">offline mode</span>}
        {grounded === true && <span className="pill good">llm</span>}
        <button className="sm" onClick={generate} disabled={busy}>
          {busy ? "writing…" : text ? "Regenerate" : "Generate briefing"}
        </button>
      </div>

      {text
        ? <div className="briefing">{text}</div>
        : <div className="empty">No briefing yet.</div>}

      <div style={{ marginTop: 13, borderTop: "1px solid var(--line)", paddingTop: 11 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="ghost xs" onClick={() => ask(s)} disabled={asking}>
              {s}
            </button>
          ))}
        </div>

        {qa.map((m, i) => (
          <div key={i} style={{ marginBottom: 9 }}>
            <div style={{
              fontSize: 10.5, color: "var(--dim)", textTransform: "uppercase",
              letterSpacing: 0.5, marginBottom: 2
            }}>
              {m.role === "user" ? "investigator" : "mulenet"}
            </div>
            <div style={{
              background: m.role === "user" ? "var(--blue-dim)" : "var(--panel-2)",
              border: "1px solid var(--line)", borderRadius: 8,
              padding: "8px 10px", fontSize: 12.5, whiteSpace: "pre-wrap"
            }}>
              {m.text}
            </div>
          </div>
        ))}
        {asking && (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            <span className="spin">◐</span> thinking…
          </div>
        )}

        <div className="row" style={{ marginTop: 6 }}>
          <input
            value={question}
            placeholder="Ask about this case…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            disabled={asking}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="sm" onClick={() => ask()} disabled={asking || !question.trim()}>
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
