import React from "react";
import { inrShort } from "../api.js";

/**
 * Layered money-trail graph.
 *
 * Nodes are positioned by DEPTH (x) — which is the whole point. The picture
 * you want a judge to see is money fanning out left-to-right through layers
 * and converging on cash-out points, with the recommended freeze set marked.
 */
export default function TrailGraph({ result, onSelect, selected }) {
  const { nodes = [], edges = [], exits = [] } = result || {};

  const layout = React.useMemo(() => {
    if (!nodes.length) return null;

    const byDepth = new Map();
    for (const n of nodes) {
      const d = n.depth ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(n);
    }
    const depths = [...byDepth.keys()].sort((a, b) => a - b);

    // exits live one column past the deepest node
    const exitCol = (depths[depths.length - 1] ?? 0) + 1;

    const COL_W = 168;
    const ROW_H = 46;
    const PAD_X = 60;
    const PAD_Y = 34;

    const maxRows = Math.max(
      ...depths.map((d) => byDepth.get(d).length),
      exits.length ? 1 : 0
    );

    const pos = new Map();
    depths.forEach((d) => {
      const col = byDepth.get(d).sort((a, b) => b.taintReceived - a.taintReceived);
      const offset = (maxRows - col.length) / 2;
      col.forEach((n, i) => {
        pos.set(n.id, {
          x: PAD_X + d * COL_W,
          y: PAD_Y + (offset + i) * ROW_H,
          node: n
        });
      });
    });

    // group exits by source account so the column stays readable
    const exitBySrc = new Map();
    for (const x of exits) {
      if (!exitBySrc.has(x.from)) exitBySrc.set(x.from, { from: x.from, tainted: 0, n: 0 });
      const e = exitBySrc.get(x.from);
      e.tainted += x.tainted;
      e.n += 1;
    }
    const exitList = [...exitBySrc.values()].sort((a, b) => b.tainted - a.tainted);
    const exitOffset = (maxRows - exitList.length) / 2;
    exitList.forEach((e, i) => {
      e.x = PAD_X + exitCol * COL_W;
      e.y = PAD_Y + (exitOffset + i) * ROW_H;
    });

    return {
      pos, depths, exitList,
      width: PAD_X * 2 + (exitCol + 1) * COL_W,
      height: PAD_Y * 2 + maxRows * ROW_H,
      colW: COL_W
    };
  }, [nodes, edges, exits]);

  if (!layout) return <div className="empty">No trail to draw yet.</div>;

  const { pos, exitList, width, height } = layout;
  const maxTaint = Math.max(...nodes.map((n) => n.taintReceived), 1);
  const strokeFor = (t) => 1 + 4 * Math.sqrt(t / maxTaint);

  const colorOf = (n) => {
    if (n.isVictim) return "#f87171";
    if (n.inPlan) return "#4ade80";
    if (n.inCut) return "#fbbf24";
    return "#60a5fa";
  };

  return (
    <div className="graph-wrap">
      <svg width={width} height={height} style={{ display: "block" }}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5468" />
          </marker>
          <marker id="arrHot" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
          </marker>
        </defs>

        {/* column headings */}
        {layout.depths.map((d) => {
          const any = [...pos.values()].find((p) => (p.node.depth ?? 0) === d);
          if (!any) return null;
          return (
            <text key={`h${d}`} x={any.x} y={16} fontSize="9.5" fill="#616c80"
                  textAnchor="middle" letterSpacing="0.8">
              {d === 0 ? "VICTIM" : `LAYER ${d}`}
            </text>
          );
        })}
        {exitList.length > 0 && (
          <text x={exitList[0].x} y={16} fontSize="9.5" fill="#616c80"
                textAnchor="middle" letterSpacing="0.8">CASH-OUT</text>
        )}

        {/* tainted transfers */}
        {edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const fast = (e.hopSeconds ?? 9999) < 900;
          const mx = (a.x + b.x) / 2;
          return (
            <g key={`e${i}`}>
              <path
                d={`M ${a.x + 26} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 28} ${b.y}`}
                fill="none"
                stroke={fast ? "#fbbf24" : "#4a5468"}
                strokeWidth={strokeFor(e.tainted)}
                strokeOpacity={fast ? 0.85 : 0.5}
                markerEnd={fast ? "url(#arrHot)" : "url(#arr)"}
              />
            </g>
          );
        })}

        {/* exit edges */}
        {exitList.map((x, i) => {
          const a = pos.get(x.from);
          if (!a) return null;
          const mx = (a.x + x.x) / 2;
          return (
            <path key={`x${i}`}
              d={`M ${a.x + 26} ${a.y} C ${mx} ${a.y}, ${mx} ${x.y}, ${x.x - 24} ${x.y}`}
              fill="none" stroke="#a78bfa" strokeWidth={strokeFor(x.tainted)}
              strokeOpacity="0.75" markerEnd="url(#arr)" />
          );
        })}

        {/* accounts */}
        {[...pos.values()].map(({ x, y, node }) => {
          const sel = selected === node.id;
          return (
            <g key={node.id} onClick={() => onSelect && onSelect(node.id)}
               style={{ cursor: "pointer" }}>
              <circle cx={x} cy={y} r={sel ? 15 : 12}
                      fill={colorOf(node)} fillOpacity={node.inPlan ? 0.95 : 0.22}
                      stroke={colorOf(node)} strokeWidth={sel ? 2.6 : 1.6} />
              <text x={x} y={y + 3.5} fontSize="9" fontWeight="700"
                    textAnchor="middle"
                    fill={node.inPlan ? "#06130b" : colorOf(node)}>
                {node.depth ?? 0}
              </text>
              <text x={x} y={y - 18} fontSize="9" fill="#8b95a7" textAnchor="middle">
                #{node.id}
              </text>
              <text x={x} y={y + 26} fontSize="9.5" fill="#e8ecf3"
                    textAnchor="middle" fontWeight="600">
                {inrShort(node.taintReceived)}
              </text>
            </g>
          );
        })}

        {/* cash-out points */}
        {exitList.map((x, i) => (
          <g key={`ex${i}`}>
            <rect x={x.x - 22} y={x.y - 11} width="44" height="22" rx="5"
                  fill="#1d1633" stroke="#a78bfa" strokeWidth="1.4" />
            <text x={x.x} y={x.y + 3.5} fontSize="8.5" fill="#a78bfa"
                  textAnchor="middle" fontWeight="700">EXIT</text>
            <text x={x.x} y={x.y + 25} fontSize="9.5" fill="#a78bfa"
                  textAnchor="middle" fontWeight="600">
              {inrShort(x.tainted)}
            </text>
          </g>
        ))}
      </svg>

      <div className="row" style={{ padding: "6px 8px 2px", gap: 14 }}>
        <Legend color="#f87171" label="victim" />
        <Legend color="#4ade80" label="recommended freeze" filled />
        <Legend color="#fbbf24" label="in min-cut" />
        <Legend color="#60a5fa" label="on the trail" />
        <Legend color="#a78bfa" label="cash-out" />
        <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
          amber edges = hop under 15 minutes
        </span>
      </div>
    </div>
  );
}

function Legend({ color, label, filled }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5,
                   fontSize: 10.5, color: "var(--muted)" }}>
      <span style={{
        width: 9, height: 9, borderRadius: 9,
        background: filled ? color : "transparent",
        border: `1.6px solid ${color}`
      }} />
      {label}
    </span>
  );
}
