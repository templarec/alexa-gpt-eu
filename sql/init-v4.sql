CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==================================================
-- USERS
-- ==================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================================================
-- MEALS
-- ==================================================

CREATE TABLE IF NOT EXISTS meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    date DATE NOT NULL,
    time TIME,

    meal_type TEXT NOT NULL,
    description TEXT NOT NULL,

    calories NUMERIC(10,2) NOT NULL DEFAULT 0,
    protein NUMERIC(10,2) NOT NULL DEFAULT 0,
    carbs NUMERIC(10,2) NOT NULL DEFAULT 0,
    fat NUMERIC(10,2) NOT NULL DEFAULT 0,

    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================================================
-- INDEXES
-- ==================================================

CREATE INDEX IF NOT EXISTS idx_meals_user_date
ON meals(user_id, date);

CREATE INDEX IF NOT EXISTS idx_meals_date
ON meals(date);

CREATE INDEX IF NOT EXISTS idx_meals_meal_type
ON meals(meal_type);

-- ==================================================
-- DEFAULT USERS
-- ==================================================

INSERT INTO users (slug, name)
VALUES
    ('lorenzo', 'Lorenzo'),
    ('elisa', 'Elisa')
ON CONFLICT (slug) DO NOTHING;