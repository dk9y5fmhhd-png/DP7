-- ============================================================
-- DP7 v4.4 — Excel se manual assignment + naye client ka queue
--
-- Problem: 4,825 customers ko haath se assign karna namumkin hai. Aur roz
-- naye client aate hain — unhe bhi kisi ko dena padta hai.
--
-- Ab do raaste:
--   1. Excel: username + caller ki do column wali file upload karein
--      → preview (kitne sahi, kitne galat) → apply
--   2. Naye client ka queue: jo aaj/kal aaye aur kisi ko assign nahi hue,
--      unki list — tick karke ya poora batch ek caller ko
--
-- Safe to run repeatedly.
-- ============================================================

-- Har Excel import ka record — kisne, kab, kitne sahi/galat
CREATE TABLE IF NOT EXISTS assign_imports (
  id          BIGSERIAL PRIMARY KEY,
  file_name   TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_rows  INTEGER NOT NULL DEFAULT 0,
  applied     INTEGER NOT NULL DEFAULT 0,
  unmatched   INTEGER NOT NULL DEFAULT 0,
  bad_caller  INTEGER NOT NULL DEFAULT 0,
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS assign_imports_at_idx ON assign_imports (uploaded_at DESC);

-- Naye client ka queue tez ho — pehla deposit + unassigned
CREATE INDEX IF NOT EXISTS customers_first_deposit_idx ON customers (first_deposit DESC);

CREATE INDEX IF NOT EXISTS customers_unassigned_idx
  ON customers (first_deposit DESC) WHERE assigned_to IS NULL;

