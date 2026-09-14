/**
 * Max-flow / min-cut over the tainted subgraph — the freeze-set selector.
 *
 * WHAT COUNTS AS AN ESCAPE ROUTE
 * ------------------------------
 *   1. REALISED EXITS   money already withdrawn at an ATM or off-ramp.
 *   2. HELD BALANCES    tainted money still sitting in a mule account. It has
 *                       not escaped yet, but it is one transfer away. This is
 *                       the money a freeze actually saves.
 *
 * If you only model (1), a case reported four minutes after the fraud — where
 * nothing has been withdrawn yet — has no sink edges, max flow is zero, and the
 * system recommends freezing nothing. Exactly backwards: that is the case where
 * freezing saves everything.
 *
 * VERTEX CUTS, NOT EDGE CUTS
 * You cannot un-send a transaction; you freeze accounts. So:
 *      every account v        ->  v_in --cap(v)--> v_out
 *      every tainted tx u->w  ->  u_out --INF--> w_in
 * Transaction edges are infinite, so the cut is pushed onto accounts.
 */

const INF = Number.MAX_SAFE_INTEGER / 4;

class FlowNetwork {
  constructor(n) {
    this.n = n;
    this.head = new Array(n).fill(-1);
    this.to = [];
    this.next = [];
    this.cap = [];
  }
  addEdge(u, v, c) {
    this.to.push(v); this.cap.push(c); this.next.push(this.head[u]);
    this.head[u] = this.to.length - 1;
    this.to.push(u); this.cap.push(0); this.next.push(this.head[v]);
    this.head[v] = this.to.length - 1;
    return this.to.length - 2;
  }
  maxflow(s, t) {
    let flow = 0;
    const n = this.n;
    for (;;) {
      const prevEdge = new Int32Array(n).fill(-1);
      const visited = new Uint8Array(n);
      visited[s] = 1;
      const queue = [s];
      let qi = 0;
      while (qi < queue.length && !visited[t]) {
        const u = queue[qi++];
        for (let e = this.head[u]; e !== -1; e = this.next[e]) {
          const v = this.to[e];
          if (!visited[v] && this.cap[e] > 1e-9) {
            visited[v] = 1;
            prevEdge[v] = e;
            queue.push(v);
          }
        }
      }
      if (!visited[t]) break;

      let push = INF;
      for (let v = t; v !== s; ) {
        const e = prevEdge[v];
        push = Math.min(push, this.cap[e]);
        v = this.to[e ^ 1];
      }
      for (let v = t; v !== s; ) {
        const e = prevEdge[v];
        this.cap[e] -= push;
        this.cap[e ^ 1] += push;
        v = this.to[e ^ 1];
      }
      flow += push;
      if (push < 1e-6) break;
    }
    return flow;
  }
  minCutReachable(s) {
    const vis = new Uint8Array(this.n);
    vis[s] = 1;
    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++];
      for (let e = this.head[u]; e !== -1; e = this.next[e]) {
        const v = this.to[e];
        if (!vis[v] && this.cap[e] > 1e-9) { vis[v] = 1; queue.push(v); }
      }
    }
    return vis;
  }
}

/** Escape capacity: money already withdrawn, plus money still held. */
function escapeCapacities(trace, victimId) {
  const cap = new Map();

  for (const x of trace.exits) {
    cap.set(x.from, (cap.get(x.from) || 0) + x.tainted);
  }

  for (const node of trace.nodes) {
    if (node.id === victimId) continue;
    const held = node.taintHeld || 0;
    if (held > 0) cap.set(node.id, (cap.get(node.id) || 0) + held);
  }

  return cap;
}

export function buildAndCut(trace, victimId, excluded = new Set()) {
  const ids = trace.nodes.map((n) => n.id);
  if (!ids.length) {
    return { maxFlow: 0, cutAccounts: [], nodeCapacity: new Map() };
  }

  const idx = new Map();
  ids.forEach((id, i) => idx.set(id, i));
  const k = ids.length;

  const IN = (i) => 2 * i;
  const OUT = (i) => 2 * i + 1;
  const SINK = 2 * k;
  const N = 2 * k + 1;

  const net = new FlowNetwork(N);
  const nodeCapacity = new Map();

  for (const node of trace.nodes) {
    const i = idx.get(node.id);
    let cap;
    if (node.id === victimId) {
      cap = INF;
    } else if (excluded.has(node.id)) {
      cap = 0;
    } else {
      cap = node.taintReceived;
    }
    nodeCapacity.set(node.id, node.id === victimId ? Infinity : node.taintReceived);
    net.addEdge(IN(i), OUT(i), cap);
  }

  for (const e of trace.edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a === undefined || b === undefined) continue;
    net.addEdge(OUT(a), IN(b), INF);
  }

  const exitCap = escapeCapacities(trace, victimId);
  for (const [from, cap] of exitCap) {
    const a = idx.get(from);
    if (a === undefined) continue;
    net.addEdge(OUT(a), SINK, cap);
  }

  const s = OUT(idx.get(victimId));
  const maxFlow = net.maxflow(s, SINK);

  const reach = net.minCutReachable(s);
  const cutAccounts = [];
  const inCut = new Set();

  for (const id of ids) {
    const i = idx.get(id);
    if (reach[IN(i)] && !reach[OUT(i)]) {
      cutAccounts.push({
        id,
        blocked: Math.round((nodeCapacity.get(id) || 0) * 100) / 100
      });
      inCut.add(id);
    }
  }

  for (const [from, cap] of exitCap) {
    if (inCut.has(from)) continue;
    const i = idx.get(from);
    if (i === undefined) continue;
    if (reach[OUT(i)]) {
      cutAccounts.push({ id: from, blocked: Math.round(cap * 100) / 100 });
      inCut.add(from);
    }
  }

  cutAccounts.sort((a, b) => b.blocked - a.blocked);

  return {
    maxFlow: Math.round(maxFlow * 100) / 100,
    cutAccounts,
    nodeCapacity
  };
}

/** Knapsack proposes, max-flow verifies. Blocked amounts are not additive. */
export function blockedBySet(trace, victimId, accountIds) {
  const baseline = buildAndCut(trace, victimId).maxFlow;
  const after = buildAndCut(trace, victimId, new Set(accountIds)).maxFlow;
  return {
    baseline: Math.round(baseline * 100) / 100,
    escapes: Math.round(after * 100) / 100,
    blocked: Math.round((baseline - after) * 100) / 100
  };
}