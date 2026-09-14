# MuleNet

**Trace the money, then pick the freeze.**

An algorithmic layer for cyber-fraud investigators that reconstructs where scam
money went and computes the *optimal* set of accounts to freeze — rather than
whatever can be identified first.

---

## The problem

When someone is scammed, the money doesn't disappear. It is **moved** — split
across layers of rented "mule" accounts within minutes, then withdrawn at ATMs
or pushed through crypto off-ramps. Each bank sees only the hops touching its
own customers, so no single institution ever sees the full path. India has
flagged over 2.47 million Layer-1 mule accounts, and the core difficulty is
that criminals move funds faster than victims can report the fraud.

The coordination infrastructure for this already exists. Complaints are routed
to whichever banks the money touched, with over 1,000 institutions onboarded.
But that system **routes and marks liens** — it does not **optimise**. Tracing
happens sequentially, one hop at a time, and the response is to freeze whatever
can be identified rather than what would actually block the most money.

**MuleNet is the algorithmic layer on top of that pipe.**

---

## What it actually does

| Stage | Algorithm | Answers |
|---|---|---|
| 1 | Time-respecting traversal | Where did the money actually go? |
| 2 | Taint attribution (pro-rata / FIFO) | How much of each balance is really the victim's? |
| 3 | Max-flow / min-cut (vertex cut) | Which smallest set of accounts blocks the most money? |
| 4 | Knapsack DP | Given only *k* actions this shift, which ones? |
| 5 | Tarjan SCC + label propagation | Circular layering, and who is running these accounts? |

### 1. Time-respecting traversal — `algo/traversal.js`

Money can only flow forward in time. A transfer that left an account at 21:31
cannot carry money that arrived at 21:33. So this is **not** a plain BFS — an
edge is traversable only if its timestamp is strictly after the taint arrived
at its source. Ignoring this is the most common way naive money-trail tools
produce confident nonsense. `O(V + E)` over the discovered subgraph.

### 2. Taint attribution — the detail that shows depth

A mule holds ₹50,000 of legitimate salary and receives ₹2.5L of dirty money.
Balance is ₹3L, of which 83.3% is dirty. It forwards ₹1.8L:

```
taint_out = 1,80,000 × (2,50,000 / 3,00,000) = ₹1,50,000
```

Without this, every hop over-claims taint and the system recommends freezing
balances that were never the victim's. Both **pro-rata** and **FIFO** ("oldest
rupees leave first") are implemented, and the UI lets you switch between them —
the answer changes, which is the point.

### 3. Min-cut — the real contribution — `algo/maxflow.js`

Freezing costs something real: innocent people lose access to their own money,
and the draft RBI directions concern *temporary holds pending investigation*.
So the goal is not "freeze everything reachable". It is:

> find the **smallest** set of accounts whose freezing blocks the **most**
> tainted money from leaving the banking system.

That is literally a minimum cut. But a plain min-cut returns *edges* — and you
cannot un-send a transaction that already happened. You freeze **accounts**. So
we apply the standard **vertex-capacity reduction**:

```
every account v      →   v_in --cap(v)--> v_out
every tainted tx u→w →   u_out --INF--> w_in
```

Because transaction edges are infinite, the min cut is *forced* to consist
entirely of `v_in→v_out` edges — i.e. of accounts. `cap(v)` is the tainted money
that passed through `v`, so cutting `v` costs exactly what freezing `v` saves.
Solved with Edmonds–Karp, `O(V·E²)`.

### 4. Knapsack DP — `algo/knapsack.js`

Min-cut gives the theoretical optimum. Reality: an investigator can action a
limited number of accounts per shift, and each freeze carries a different
false-positive cost. A dormant account that woke up an hour ago is cheap.
Someone's active salary account is expensive.

```
maximise    Σ tainted rupees blocked
subject to  Σ action cost ≤ budget
```

**The subtlety that matters:** blocked amounts are **not additive**. Freezing an
upstream mule also reduces what flows to the ones beneath it. So the DP uses
per-account taint as a *ranking heuristic only*, and every candidate plan is
then verified exactly by re-running max-flow with those accounts removed.

> **Knapsack proposes, max-flow verifies.**

The UI shows min-cut, knapsack and a greedy baseline side by side — all three
verified the same way. Greedy reliably loses, because it spends the whole budget
on one expensive account.

---

## Where each technology sits

```
Simulator ──▶ Postgres ──▶ ALGORITHM CORE ──┬──▶ LLM briefing
(ground truth)                              ├──▶ Map + IFSC geo
                                            ├──▶ Shared flag registry (chain)
                                            └──▶ Precision / recall harness
```

**LLM** — explanation, not decision. It never picks accounts and never invents a
rupee figure; every number it cites was computed by the solvers and handed to it
in an evidence block. A freeze that cannot be justified is a freeze that gets
litigated, so this is a **compliance requirement**, not garnish. It also handles
victim intake, because complaints arrive as narrative in mixed languages, not as
form fields.

**Blockchain** — a shared mule-flag registry that no single bank owns. Only
salted SHA-256 hashes of `(bank, account number)` are written; never an account
number, name, IFSC or amount. Competing banks cannot hand each other customer
data, and none will accept a rival operating the registry that decides whose
customers get frozen. That is a multi-party trust problem, which is the one
thing a permissioned ledger is genuinely for. India already runs such a registry
across 61+ banks — this is an argument about the trust model, not an invented
need.

**Maps + IFSC geolocation** — money surfacing 1,400 km away four minutes later
is an **anomaly feature**, not a visual. Implausible implied speed feeds the
scoring; the animation is a by-product.

**Simulator** — a synthetic economy (salary credits, merchant spend, P2P, ATM
withdrawals with a power-law merchant distribution) with **injected fraud rings
of known ground truth**. That is what makes precision, recall and
time-to-detection reportable.

---

## The honest weakness, and why it becomes a strength

The data is synthetic. There is no public dataset of labelled mule networks, and
there never will be.

The fix turns it into an advantage: because every injected ring is labelled, the
detector can be **scored against ground truth** — precision, recall, F1, a
threshold sweep, and median time-to-detection. A project running on "real"
unlabelled data cannot evaluate itself at all.

The ground-truth columns (`accounts.is_mule`, `ring_members`) are read **only**
by the evaluation harness. The detection code never sees them.

---

## Stack

- **React 18 + Vite** — frontend
- **Node 18+ / Express** — API
- **PostgreSQL** — accounts, transactions, cases, ground truth
- **Solidity 0.8.24 + Hardhat + ethers v6** — `MuleFlagRegistry` on Polygon Amoy
- **Leaflet + OpenStreetMap** — free, keyless map tiles
- **LLM** — Groq (free), Gemini (free), or Ollama (fully offline)

Everything is free. No paid API at any point. Algorithms are hand-written in
plain JavaScript — **no graph database**, because writing the traversal *is* the
project.

> **On Polygon Mumbai:** Mumbai was shut down in April 2024. **Amoy**
> (chain ID `80002`) is the current testnet. If your brief says "Mumbai", Amoy
> is the correct modern substitute — worth saying out loud to judges.

---

## Repository layout

```
mulenet/
├── contracts/
│   ├── contracts/MuleFlagRegistry.sol
│   └── scripts/deploy.js
├── server/
│   └── src/
│       ├── schema.sql          tables + ground-truth tables
│       ├── seed.js             schema + synthetic world
│       ├── evaluate.js         CLI precision/recall harness
│       ├── sim/generate.js     economy + injected rings
│       ├── algo/
│       │   ├── traversal.js    time-respecting BFS + taint
│       │   ├── maxflow.js      Edmonds-Karp + vertex min-cut
│       │   ├── knapsack.js     0/1 DP + greedy baseline
│       │   ├── features.js     behavioural scoring, action cost, geo-velocity
│       │   ├── clusters.js     Tarjan SCC + label propagation
│       │   └── pipeline.js     orchestrates all of the above
│       ├── lib/{llm,prompts}.js
│       └── routes/{cases,accounts,metrics,registry}.js
└── client/
    └── src/
        ├── chain.js            wallet + contract (all optional)
        └── components/         graph, map, freeze plan, briefing, metrics
```

---

## Running it

### Prerequisites

- Node.js 18+ (`node -v`)
- PostgreSQL 13+ running locally
- A free Groq API key — https://console.groq.com (30 seconds, no card)

### Step 1 — Create the database

```bash
createdb mulenet
# if createdb isn't on PATH:
# psql -U postgres -c "CREATE DATABASE mulenet;"
```


### Step 2 — Start the API

```bash
cd server
npm install
cp .env.example .env
```

Edit `server/.env`:

```env
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/mulenet
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_your_key_here
```

Then:

```bash
npm test             # verify the algorithms (18 assertions, no DB needed)
npm run db:setup     # schema + ~1,200 accounts, ~40k txns, 40 fraud rings
node src/scenarios.js
npm start            # http://localhost:4000
```

Verify:

```bash
curl http://localhost:4000/api/health
# {"ok":true,"db":"up","llm":{"provider":"groq","configured":true}}
```

### Step 3 — Start the frontend

```bash
cd client
npm install
cp .env.example .env    # leave blank to run with no wallet at all
npm run dev             # http://localhost:5173
```

**You now have a fully working demo.** Pick any ring and hit **Trace the money**.

### Step 4 — Check the numbers from the terminal

```bash
cd server
npm run evaluate        # or: npm run evaluate 30
```

Prints precision / recall / F1 across a threshold sweep, how often knapsack beat
greedy, recovery rate, and median latency. **Screenshot this for your slides.**

---

### Step 5 (optional) — Deploy the shared registry

Everything above works without it.

**Local chain (fastest, no faucet):**

```bash
cd contracts
npm install
npx hardhat node          # terminal A, leave running
```

Terminal B:

```bash
cd contracts
npm run deploy:local
```

Copy the printed address into `client/.env`:

```env
VITE_REGISTRY_ADDRESS=0x5FbDB...
VITE_CHAIN_ID=31337
VITE_CHAIN_NAME=Hardhat Local
```

**Polygon Amoy (what you demo):**

1. Free test POL: https://faucet.polygon.technology (select **Amoy**)
2. `cd contracts && cp .env.example .env`, add `DEPLOYER_PRIVATE_KEY=...`
3. `npm run deploy:amoy`
4. Address into `client/.env` with `VITE_CHAIN_ID=80002`
5. Restart `npm run dev`, click **Connect wallet**

---

## Build order for the next five days

Each phase must demo standalone. **Monday evening is the real deadline** — if
phases 1–3 pass their assertions by then, the project is safe and everything
after is polish.

| Day | Deliverable | Checkpoint |
|---|---|---|
| Sat 13 | Seed + simulator | Ring structure looks like real layering |
| Sun 14 | Traversal + taint | Hand-check the pro-rata arithmetic on one hop |
| **Mon 15** | **Min-cut + knapsack** | **Knapsack beats greedy on most rings** |
| Tue 16 | Frontend + map replay | The thing judges actually watch |
| Wed 17 | LLM + contract + rehearsal | Cut ruthlessly from here |
| Thu 18 | Hackathon | — |

If you slip, drop SCC, community detection and the contract **before** you drop
anything in phases 1–3.

---

## Four-minute demo script

**1. The claim (20s).** "Scam money is never recovered because it moves faster
than anyone can trace it. RBI published draft rules on mule accounts on
11 September, and comments close on 2 October."

**2. Fire a case (30s).** Pick a ring, hit **Trace the money**. Point at the
elapsed time — a few hundred milliseconds for what is currently a manual chase.

**3. The trail (45s).** Layers view: fan-out, reconvergence, cash-out. Amber
edges are hops under 15 minutes. Switch to **Map**, hit **Replay layering** and
let it animate — money crossing the country in minutes.

**4. Taint (30s).** Click a mule. Show ₹X received, ₹Y still held, and that its
retention ratio is near zero with no salary credits. Flip the taint model to
FIFO and show the number move.

**5. The money shot (60s).** Freeze plan panel. Three bars:
min-cut (optimum), knapsack (recommended), greedy (obvious). Say it plainly:
*"Same budget. Knapsack blocks ₹X more, because greedy spends everything on one
expensive account — and freezing that account hurts someone real."*

**6. Justification (30s).** Generate the briefing. Note that the model explains
but never decides.

**7. Proof (35s).** Evaluation tab → **Run evaluation**. Precision, recall,
median latency against labelled rings. *"This is how we know it works rather
than just looks good."*

**8. Cross-bank (20s).** Submit flags, then **Check as another bank** — a second
institution learns the account is flagged without either side disclosing a
customer.

---

## Questions judges will ask

**"Isn't the data fake?"**
Yes, and deliberately. There is no public labelled mule dataset. Because we
generate ground truth, we can report precision and recall — most projects can't
evaluate themselves at all. Show the Evaluation tab.

**"Why blockchain? Couldn't this be a database?"**
The analytics could. The registry couldn't. Competing banks won't let a rival
operate the list that decides whose customers get frozen, and can't hand each
other customer data. Name it: shared registry, no owner, hashes only. Then add
the honest part — *"delete the chain and the tracing still works; the wallet is
optional."*

**"Doesn't CFCFRMS already do this?"**
It routes complaints to the right banks and marks liens — a coordination pipe,
and a valuable one. It doesn't optimise. We add parallel traversal, correct
taint attribution at depth, and an optimal freeze set under a real action
budget.

**"What if the LLM is down?"**
Every LLM path has a deterministic fallback. Set `LLM_PROVIDER=none` and the
whole demo still runs — briefing included, just blunter. Hackathon wifi has
killed better projects.

**"Could you freeze an innocent person?"**
Yes, which is why action cost exists and why we don't just freeze everything
reachable. Show the threshold sweep: lower thresholds catch more mules and
freeze more innocents. That trade-off is explicit, not hidden.

---

## What is deliberately not built

- **Real bank integration.** Needs regulatory standing this project doesn't have.
- **Live streaming ingestion.** Batch tracing is the right shape for a case.
- **Device/IP correlation.** Would sharpen clustering considerably.
- **Federated computation.** Banks currently return edges; true privacy-preserving
  cross-bank traversal is the real research problem.

---

## API reference

| Method | Endpoint | Does |
|---|---|---|
| `GET` | `/api/health` | db + llm status |
| `GET` | `/api/metrics/stats` | dataset size |
| `GET` | `/api/cases/rings` | injected rings (demo entry points) |
| `POST` | `/api/cases/trace` | **the full pipeline** |
| `POST` | `/api/cases/compare-taint` | pro-rata vs FIFO on one case |
| `POST` | `/api/cases/intake` | narrative complaint → structured fields |
| `POST` | `/api/cases/explain` | investigator briefing |
| `POST` | `/api/cases/ask` | question against one case |
| `GET` | `/api/accounts/:id` | behavioural profile + ground truth |
| `POST` | `/api/metrics/evaluate` | precision / recall / F1 |
| `POST` | `/api/metrics/sweep` | threshold sweep |
| `POST` | `/api/registry/prepare` | freeze plan → salted hashes |
| `POST` | `/api/registry/lookup` | cross-bank hash check |

---

## Troubleshooting

**`ECONNREFUSED ::1:5432`** — Postgres isn't running, or use `127.0.0.1` instead
of `localhost` in `DATABASE_URL`.

**`password authentication failed`** — real Postgres password in `DATABASE_URL`.

**`npm run db:setup` is slow** — it inserts ~40k rows. Reduce with
`SIM_ACCOUNTS=600 SIM_RINGS=20` in `server/.env`.

**"Nothing traced"** — the fraud timestamp is after that account's last outgoing
transaction. Pick a ring from the dropdown; those are guaranteed to trace.

**`LLM 401` / `429`** — bad or rate-limited key. The fallback catches it; check
the server console for the warning line.

**Map tiles not loading** — OpenStreetMap needs internet. The Layers view works
fully offline, so demo from that if the venue wifi is bad.

**`VITE_REGISTRY_ADDRESS is not set`** — expected until you deploy. Everything
except the registry buttons works without it.

---

*MuleNet is a decision-support prototype. It records and recommends; it does not
freeze accounts. Freezing is a regulated banking action.*
