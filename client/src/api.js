const BASE = "/api";

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  health:     () => req("/health"),
  stats:      () => req("/metrics/stats"),

  rings:      () => req("/cases/rings"),
  trace:      (body) => req("/cases/trace", { method: "POST", body }),
  compare:    (body) => req("/cases/compare-taint", { method: "POST", body }),
  intake:     (body) => req("/cases/intake", { method: "POST", body }),
  explain:    (result) => req("/cases/explain", { method: "POST", body: { result } }),
  ask:        (result, question) =>
                req("/cases/ask", { method: "POST", body: { result, question } }),
  history:    () => req("/cases/history"),

  account:    (id) => req(`/accounts/${id}`),

  evaluate:   (body) => req("/metrics/evaluate", { method: "POST", body }),
  sweep:      (body) => req("/metrics/sweep", { method: "POST", body }),

  prepareFlags: (body) => req("/registry/prepare", { method: "POST", body }),
  recordFlag:   (body) => req("/registry/record", { method: "POST", body }),
  lookupFlag:   (account_hash) =>
                  req("/registry/lookup", { method: "POST", body: { account_hash } })
};

export const inr = (n) =>
  "\u20B9" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

export const inrShort = (n) => {
  const v = Number(n || 0);
  if (v >= 1e7) return "\u20B9" + (v / 1e7).toFixed(2) + "Cr";
  if (v >= 1e5) return "\u20B9" + (v / 1e5).toFixed(2) + "L";
  if (v >= 1e3) return "\u20B9" + (v / 1e3).toFixed(1) + "K";
  return "\u20B9" + Math.round(v);
};

export const timeOf = (ts) =>
  new Date(ts).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });
