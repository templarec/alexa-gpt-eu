-- ==================================================
-- ACTIVITIES
-- ==================================================

CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    activity_date DATE NOT NULL,
    time TIME,

    source TEXT,
    activity_type TEXT NOT NULL,
    description TEXT,

    calories NUMERIC(10,2) NOT NULL DEFAULT 0,
    distance_km NUMERIC(10,3),
    duration_min NUMERIC(10,2),
    steps INTEGER,
    avg_speed_kmh NUMERIC(10,2),

    source_id TEXT,
    source_url TEXT,
    raw_json JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_user_date
ON activities(user_id, activity_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_id_unique
ON activities(source_id)
WHERE source_id IS NOT NULL;

-- ==================================================
-- BODY METRICS
-- ==================================================

CREATE TABLE IF NOT EXISTS body_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    date DATE NOT NULL,
    time TIME,

    source TEXT,

    weight TEXT,
    body_fat TEXT,
    muscle_mass TEXT,
    water_mass TEXT,
    fat_mass TEXT,
    lean_mass TEXT,

    raw_json JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_body_metrics_user_date
ON body_metrics(user_id, date);