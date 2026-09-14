-- MuleNet schema
-- Postgres 13+

DROP TABLE IF EXISTS freeze_actions CASCADE;
DROP TABLE IF EXISTS taint       CASCADE;
DROP TABLE IF EXISTS cases       CASCADE;
DROP TABLE IF EXISTS reports     CASCADE;
DROP TABLE IF EXISTS ring_members CASCADE;
DROP TABLE IF EXISTS rings       CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS accounts    CASCADE;
DROP TABLE IF EXISTS banks       CASCADE;

CREATE TABLE banks (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  ifsc_pfx  TEXT NOT NULL
);

CREATE TABLE accounts (
  id            SERIAL PRIMARY KEY,
  acct_no       TEXT UNIQUE NOT NULL,
  bank_code     TEXT NOT NULL REFERENCES banks(code),
  ifsc          TEXT NOT NULL,
  city          TEXT NOT NULL,
  lat           NUMERIC NOT NULL,
  lon           NUMERIC NOT NULL,
  holder_hash   TEXT NOT NULL,          -- never store a real name
  opened_at     TIMESTAMPTZ NOT NULL,
  kyc_level     TEXT NOT NULL DEFAULT 'FULL',
  opening_bal   NUMERIC NOT NULL DEFAULT 0,
  -- ground truth, used ONLY for scoring; never fed to the algorithms
  is_mule       BOOLEAN NOT NULL DEFAULT FALSE,
  is_cashout    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE transactions (
  id        BIGSERIAL PRIMARY KEY,
  src       INTEGER REFERENCES accounts(id),      -- NULL = external credit
  dst       INTEGER REFERENCES accounts(id),      -- NULL = cash-out / exit
  amount    NUMERIC NOT NULL CHECK (amount > 0),
  ts        TIMESTAMPTZ NOT NULL,
  channel   TEXT NOT NULL,                        -- UPI / IMPS / NEFT / ATM / CARD
  ref_id    TEXT NOT NULL,
  is_fraud  BOOLEAN NOT NULL DEFAULT FALSE        -- ground truth only
);

-- The two indexes the whole project depends on. Every traversal is time-ordered.
CREATE INDEX idx_tx_src_ts ON transactions(src, ts);
CREATE INDEX idx_tx_dst_ts ON transactions(dst, ts);

CREATE TABLE rings (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  victim_id   INTEGER NOT NULL REFERENCES accounts(id),
  amount      NUMERIC NOT NULL,
  fraud_ts    TIMESTAMPTZ NOT NULL,
  depth       INTEGER NOT NULL
);

CREATE TABLE ring_members (
  ring_id     INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  layer       INTEGER NOT NULL,
  PRIMARY KEY (ring_id, account_id)
);

CREATE TABLE reports (
  id            SERIAL PRIMARY KEY,
  victim_acct   INTEGER NOT NULL REFERENCES accounts(id),
  amount        NUMERIC NOT NULL,
  fraud_ts      TIMESTAMPTZ NOT NULL,
  reported_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  narrative     TEXT NOT NULL DEFAULT '',
  playbook      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id             SERIAL PRIMARY KEY,
  report_id      INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  victim_acct    INTEGER NOT NULL REFERENCES accounts(id),
  amount         NUMERIC NOT NULL,
  fraud_ts       TIMESTAMPTZ NOT NULL,
  max_depth      INTEGER NOT NULL DEFAULT 6,
  taint_model    TEXT NOT NULL DEFAULT 'PRORATA',
  result         JSONB,
  elapsed_ms     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE freeze_actions (
  id           SERIAL PRIMARY KEY,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  blocked      NUMERIC NOT NULL,
  action_cost  NUMERIC NOT NULL,
  chosen_by    TEXT NOT NULL,          -- MINCUT | KNAPSACK
  chain_tx     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ring_members_acct ON ring_members(account_id);
