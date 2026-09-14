import React from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import { inrShort } from "../api.js";

/**
 * Geographic view of the layering.
 *
 * This is not decoration. Money surfacing 1,400 km away four minutes later is
 * an anomaly feature — no person moved, the account network did. Hops flagged
 * `implausible` by the backend are drawn in red, and the animation replays the
 * trail in true timestamp order so the speed is visible rather than asserted.
 */

function FitBounds({ points }) {
  const map = useMap();
  React.useEffect(() => {
    if (!points.length) return;
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
      { padding: [42, 42], maxZoom: 7 }
    );
  }, [points, map]);
  return null;
}

export default function TrailMap({ result, onSelect, selected }) {
  const { nodes = [], edges = [] } = result || {};
  const [step, setStep] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);

  // edges in true chronological order — the replay is the demo
  const ordered = React.useMemo(
    () => [...edges].sort((a, b) => new Date(a.ts) - new Date(b.ts)),
    [edges]
  );

  React.useEffect(() => { setStep(ordered.length); setPlaying(false); }, [ordered.length]);

  React.useEffect(() => {
    if (!playing) return;
    if (step >= ordered.length) { setPlaying(false); return; }
    const t = setTimeout(() => setStep((s) => s + 1), 420);
    return () => clearTimeout(t);
  }, [playing, step, ordered.length]);

  const posOf = React.useMemo(() => {
    const m = new Map();
    for (const n of nodes) if (n.lat != null) m.set(n.id, [n.lat, n.lon]);
    return m;
  }, [nodes]);

  const points = [...posOf.values()];
  if (!points.length) return <div className="empty">No geography to plot yet.</div>;

  const visible = ordered.slice(0, step);
  const activeIds = new Set([result.victimId]);
  visible.forEach((e) => { activeIds.add(e.from); activeIds.add(e.to); });

  const colorOf = (n) => {
    if (n.isVictim) return "#f87171";
    if (n.inPlan) return "#4ade80";
    if (n.inCut) return "#fbbf24";
    return "#60a5fa";
  };

  const lastEdge = visible[visible.length - 1];

  return (
    <div>
      <div className="map-wrap">
        <MapContainer center={[22.5, 80]} zoom={5} scrollWheelZoom
                      style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds points={points} />

          {visible.map((e, i) => {
            const a = posOf.get(e.from), b = posOf.get(e.to);
            if (!a || !b) return null;
            const isLast = i === visible.length - 1;
            return (
              <Polyline
                key={`e${i}`}
                positions={[a, b]}
                pathOptions={{
                  color: e.implausible ? "#f87171"
                       : (e.hopSeconds ?? 9999) < 900 ? "#fbbf24" : "#4a5468",
                  weight: isLast ? 3.4 : 1.9,
                  opacity: isLast ? 1 : 0.65,
                  dashArray: e.implausible ? "5 4" : null
                }}
              >
                <Tooltip sticky>
                  <div style={{ fontSize: 11 }}>
                    #{e.from} &rarr; #{e.to}<br />
                    {inrShort(e.tainted)} after {e.hopSeconds}s
                    {e.km != null && <><br />{e.km} km &middot; {e.kmph} km/h</>}
                    {e.implausible && <><br /><b>geographically implausible</b></>}
                  </div>
                </Tooltip>
              </Polyline>
            );
          })}

          {nodes.filter((n) => posOf.has(n.id)).map((n) => {
            const on = activeIds.has(n.id);
            return (
              <CircleMarker
                key={n.id}
                center={posOf.get(n.id)}
                radius={n.isVictim ? 9 : selected === n.id ? 10 : 6 + Math.min(6, n.depth ?? 0)}
                pathOptions={{
                  color: colorOf(n),
                  weight: selected === n.id ? 3 : 1.6,
                  fillColor: colorOf(n),
                  fillOpacity: on ? (n.inPlan ? 0.85 : 0.4) : 0.06,
                  opacity: on ? 1 : 0.2
                }}
                eventHandlers={{ click: () => onSelect && onSelect(n.id) }}
              >
                <Tooltip>
                  <div style={{ fontSize: 11 }}>
                    <b>#{n.id}</b> {n.bank} &middot; {n.city}<br />
                    depth {n.depth} &middot; {inrShort(n.taintReceived)}<br />
                    risk {n.riskScore}/100
                    {n.inPlan && <><br /><b>recommended freeze</b></>}
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      <div className="row" style={{ marginTop: 9 }}>
        <button className="sm"
                onClick={() => { setStep(0); setPlaying(true); }}>
          Replay layering
        </button>
        <button className="ghost sm"
                onClick={() => setPlaying((p) => !p)}
                disabled={step >= ordered.length && !playing}>
          {playing ? "Pause" : "Resume"}
        </button>
        <button className="ghost sm" onClick={() => { setStep(ordered.length); setPlaying(false); }}>
          Show all
        </button>
        <input
          type="range" min="0" max={ordered.length} value={step}
          onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }}
          style={{ flex: 1, minWidth: 140 }}
        />
        <span className="pill">{step} / {ordered.length} hops</span>
        {lastEdge && (
          <span className="pill info">
            {new Date(lastEdge.ts).toLocaleTimeString("en-IN", {
              hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>
    </div>
  );
}
