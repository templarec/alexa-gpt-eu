ALTER TABLE meals
ADD COLUMN IF NOT EXISTS sheet_row_hash TEXT;

ALTER TABLE activities
ADD COLUMN IF NOT EXISTS sheet_row_hash TEXT;

ALTER TABLE body_metrics
ADD COLUMN IF NOT EXISTS sheet_row_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meals_sheet_row_hash
ON meals(sheet_row_hash)
WHERE sheet_row_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_sheet_row_hash
ON activities(sheet_row_hash)
WHERE sheet_row_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_body_metrics_sheet_row_hash
ON body_metrics(sheet_row_hash)
WHERE sheet_row_hash IS NOT NULL;