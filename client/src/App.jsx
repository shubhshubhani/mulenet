import React from "react";
import { api, inr, inrShort } from "./api.js";
import WalletBar from "./components/WalletBar.jsx";
import CaseRunner from "./components/CaseRunner.jsx";
import TrailGraph from "./components/TrailGraph.jsx";
import TrailMap from "./components/TrailMap.jsx";
import FreezePlan from "./components/FreezePlan.jsx";
import Briefing from "./components/Briefing.jsx";
import MetricsPanel from "./components/MetricsPanel.jsx";
import AccountPanel from "./components/AccountPanel.jsx";

export default function App() {
  const [health, setHealth] = React.useState(null);
  const [stats, setStats] = React.useState(null);
  const [wallet, setWallet] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState("trace");
  const [view, setView] = React.useState("graph");
  const [selected, setSelected] = React.useState(null);
  const [banner, setBanner] = React.useState(null);

  const notify = (msg, kind = "err") => {
    setBanner({ msg, kind });
    setTimeout(() => setBanner(null), 6500);
  };

  React.useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.stats().then(setStats).catch(() => {});
  }, []);

  const llmOk = health?.llm?.configured;
  const s = result?.summary;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>MuleNet</h1>
          <span>trace the money, then pick the freeze</span>
        </div>
        <div className="spacer" />
        <div className="row">
          {stats && (
            <span className="pill">
              {stats.accounts.toLocaleString("en-IN")} accounts ·{" "}
              {stats.transactions.toLocaleString("en-IN")} txns ·{" "}
              {stats.rings} rings
            </span>
          )}
          {health && (
            <span className={`pill ${health.db === "up" ? "good" : "bad"}`}>
              db {health.db === "up" ? "up" : "down"}
            </span>
          )}
          {health && (
            <span className={`pill ${llmOk ? "good" : "warn"}`}>
              {llmOk ? health.llm.provider : "llm fallback"}
            </span>
          )}
          <WalletBar wallet={wallet} setWallet={setWallet} notify={notify} />
        </div>
      </header>

      {banner && <div className={`banner ${banner.kind}`}>{banner.msg}</div>}

      <div className="tabs">
        <button className={tab === "trace" ? "active" : ""}
                onClick={() => setTab("trace")}>Trace a case</button>
        <button className={tab === "metrics" ? "active" : ""}
                onClick={() => setTab("metrics")}>Evaluation</button>
      </div>

      {tab === "metrics" && <MetricsPanel notify={notify} />}

      {tab === "trace" && (
        <>
          <CaseRunner
            onResult={(r) => { setResult(r); setSelected(null); }}
            notify={notify} busy={busy} setBusy={setBusy} />

          {!result && (
            <div className="card">
              <div className="empty">
                Pick a reported fraud above and hit <b>Trace the money</b>.
              </div>
            </div>
          )}

          {result && s && (
            <>
              <div className="grid-4">
                <div className="tile">
                  <div className="k">DEFRAUDED</div>
                  <div className="v red">{inrShort(result.amount)}</div>
                  <div className="n">{inr(result.amount)}</div>
                </div>
                <div className="tile">
                  <div className="k">TRACED</div>
                  <div className="v blue">{s.tracedNodes}</div>
                  <div className="n">
                    accounts, {s.tracedEdges} transfers, depth {s.maxDepth}
                  </div>
                </div>
                <div className="tile">
                  <div className="k">STILL HELD</div>
                  <div className="v green">{inrShort(s.stillHeld)}</div>
                  <div className="n">still sitting in mule accounts</div>
                </div>
                <div className="tile">
                  <div className="k">ALREADY CASHED OUT</div>
                  <div className="v red">{inrShort(s.exited)}</div>
                  <div className="n">withdrawn, no account left to freeze</div>
                </div>
              </div>

              <div className="card tight" style={{ marginTop: 14 }}>
                <div className="row">
                  <span className="pill info">
                    {result.stats?.candidatesScanned} candidates scanned
                  </span>
                  <span className="pill">
                    {result.stats?.txnsScanned?.toLocaleString("en-IN")} txns swept
                  </span>
                  <span className="pill">{result.stats?.taintModel} taint</span>
                  {s.operators > 0 && (
                    <span className="pill violet">
                      {s.operators} operator cluster{s.operators > 1 ? "s" : ""}
                    </span>
                  )}
                  {s.cycles > 0 && (
                    <span className="pill warn">
                      {s.cycles} circular layering loop{s.cycles > 1 ? "s" : ""}
                    </span>
                  )}
                  <div className="spacer" />
                  <span className="pill good">{result.elapsedMs} ms</span>
                </div>
              </div>

              <div className="card">
                <div className="row" style={{ marginBottom: 10 }}>
                  <div>
                    <h2>The money trail</h2>
                    <div className="sub">
                      Click any account for its behavioural profile.
                    </div>
                  </div>
                  <div className="spacer" />
                  <div className="row" style={{ gap: 4 }}>
                    <button className={view === "graph" ? "sm" : "ghost sm"}
                            onClick={() => setView("graph")}>Layers</button>
                    <button className={view === "map" ? "sm" : "ghost sm"}
                            onClick={() => setView("map")}>Map</button>
                  </div>
                </div>

                {view === "graph"
                  ? <TrailGraph result={result} onSelect={setSelected} selected={selected} />
                  : <TrailMap result={result} onSelect={setSelected} selected={selected} />}
              </div>

              <div className="grid-2">
                <div>
                  <FreezePlan
                    result={result} wallet={wallet} notify={notify}
                    onSelect={setSelected} selected={selected} />
                </div>
                <div>
                  <Briefing result={result} notify={notify} />
                  <AccountPanel
                    accountId={selected} result={result}
                    onClose={() => setSelected(null)} />
                </div>
              </div>
            </>
          )}
        </>
      )}

      <footer style={{ color: "var(--dim)", fontSize: 11, padding: "22px 0 8px" }}>
        MuleNet is a decision-support prototype running on synthetic data with
        injected ground truth. It records and recommends; it does not freeze
        accounts. Only salted hashes are ever written on-chain.
      </footer>
    </div>
  );
}
