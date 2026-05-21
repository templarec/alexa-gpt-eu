CREATE TABLE IF NOT EXISTS daily_stats (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  intake NUMERIC,
  activity NUMERIC,
  net NUMERIC,
  target NUMERIC,
  remaining NUMERIC,
  protein NUMERIC,
  carbs NUMERIC,
  fat NUMERIC,
  weight NUMERIC,
  body_fat NUMERIC,
  tdee_formula NUMERIC,
  tdee_adaptive NUMERIC,
  tdee_final NUMERIC,
  notes TEXT,
  source TEXT DEFAULT 'runtime',
  generated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date
ON daily_stats(user_id, date);