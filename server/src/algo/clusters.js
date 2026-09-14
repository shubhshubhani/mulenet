/**
 * Tarjan's SCC + label-propagation communities.
 *
 * SCC — CIRCULAR LAYERING
 * Syndicates deliberately cycle money back through accounts they have already
 * used, because a linear trace looks like a chain and a loop looks like noise.
 * A strongly connected component in the tainted subgraph is exactly that loop,
 * and Tarjan finds every one of them in a single O(V+E) pass.
 *
 * COMMUNITIES — ONE OPERATOR, MANY ACCOUNTS
 * An investigator does not care about "47 suspicious accounts". They care that
 * those 47 accounts are being run by 3 people. Label propagation over the
 * undirected co-activity graph collapses the former into the latter.
 */

/** Iterative Tarjan — recursion would blow the stack on deep chains. */
export function tarjanSCC(nodeIds, edges) {
  const idx = new Map();
  nodeIds.forEach((id, i) => idx.set(id, i));
  const n = nodeIds.length;

  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a === undefined || b === undefined) continue;
    adj[a].push(b);
  }

  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n).fill(0);
  const onStack = new Uint8Array(n);
  const stack = [];
  const comps = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;

    // frame: [node, next-child-pointer]
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];

      if (frame[1] === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = 1;
      }

      let recursed = false;
      while (frame[1] < adj[v].length) {
        const w = adj[v][frame[1]++];
        if (index[w] === -1) {
          work.push([w, 0]);
          recursed = true;
          break;
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      }
      if (recursed) continue;

      if (low[v] === index[v]) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          onStack[w] = 0;
          comp.push(nodeIds[w]);
          if (w === v) break;
        }
        if (comp.length > 1) comps.push(comp);   // only real cycles are useful
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
    }
  }
  return comps;
}

/**
 * Label propagation over an undirected weighted graph.
 *
 * Weight combines three signals that suggest common control:
 *   - a direct tainted transfer between the two accounts
 *   - shared timing (hops seconds apart imply automation, not two humans)
 *   - shared bank / shared city
 */
export function detectCommunities(nodeIds, edges, featureMap, rounds = 12) {
  const idx = new Map();
  nodeIds.forEach((id, i) => idx.set(id, i));
  const n = nodeIds.length;
  if (!n) return [];

  const adj = Array.from({ length: n }, () => new Map());
  const bump = (a, b, w) => {
    if (a === b) return;
    adj[a].set(b, (adj[a].get(b) || 0) + w);
    adj[b].set(a, (adj[b].get(a) || 0) + w);
  };

  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a === undefined || b === undefined) continue;
    let w = 1;
    if ((e.hopSeconds ?? 9999) < 600) w += 1.5;   // automated-looking hop
    const fa = featureMap.get(e.from), fb = featureMap.get(e.to);
    if (fa && fb) {
      if (fa.bank === fb.bank) w += 0.4;
      if (fa.city === fb.city) w += 0.4;
    }
    bump(a, b, w);
  }

  // deterministic init
  const label = new Int32Array(n);
  for (let i = 0; i < n; i++) label[i] = i;

  const order = [...Array(n).keys()];
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    // rotate order each round instead of shuffling, so runs are reproducible
    for (let k = 0; k < n; k++) {
      const i = order[(k + r) % n];
      if (!adj[i].size) continue;
      const tally = new Map();
      for (const [j, w] of adj[i]) {
        tally.set(label[j], (tally.get(label[j]) || 0) + w);
      }
      let best = label[i], bestW = -1;
      for (const [lab, w] of tally) {
        if (w > bestW || (w === bestW && lab < best)) { best = lab; bestW = w; }
      }
      if (best !== label[i]) { label[i] = best; changed = true; }
    }
    if (!changed) break;
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(nodeIds[i]);
  }

  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((members, i) => ({
      id: `OP-${String(i + 1).padStart(2, "0")}`,
      size: members.length,
      members
    }));
}
