const { query } = require("../db/postgres");
const { parseSheetNumber } = require("../utils/numbers-and-dates");

async function getUserIdBySlug(slug) {
  const result = await query(
    `
    SELECT id
    FROM users
    WHERE slug = $1
    LIMIT 1
    `,
    [slug],
  );

  return result.rows[0]?.id || null;
}

function formatPostgresDate(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function normalizePostgresCalories(value) {
  const number = parseSheetNumber(value);

  if (Math.abs(number) > 3000) {
    return number / 100;
  }

  return number;
}

function normalizePostgresMetric(value) {
  const number = parseSheetNumber(value);

  if (Math.abs(number) > 100000) {
    return number / 100;
  }

  return number;
}

async function insertActivity({
  userSlug,
  activityDate,
  time,
  source,
  activityType,
  description,
  calories,
  distanceKm,
  durationMin,
  steps,
  avgSpeedKmh,
  sourceId,
  sourceUrl,
  rawJson,
}) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    INSERT INTO activities (
      user_id,
      activity_date,
      time,
      source,
      activity_type,
      description,
      calories,
      distance_km,
      duration_min,
      steps,
      avg_speed_kmh,
      source_id,
      source_url,
      raw_json
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
    )
    ON CONFLICT (user_id, source_id)
    WHERE source_id IS NOT NULL
    DO UPDATE SET
      activity_date = EXCLUDED.activity_date,
      time = EXCLUDED.time,
      source = EXCLUDED.source,
      activity_type = EXCLUDED.activity_type,
      description = EXCLUDED.description,
      calories = EXCLUDED.calories,
      distance_km = EXCLUDED.distance_km,
      duration_min = EXCLUDED.duration_min,
      steps = EXCLUDED.steps,
      avg_speed_kmh = EXCLUDED.avg_speed_kmh,
      source_url = EXCLUDED.source_url,
      raw_json = EXCLUDED.raw_json,
      updated_at = NOW()
    RETURNING id
    `,
    [
      userId,
      activityDate,
      time || null,
      source || null,
      activityType,
      description || null,
      Number(calories || 0),
      distanceKm ?? null,
      durationMin ?? null,
      steps ?? null,
      avgSpeedKmh ?? null,
      sourceId || null,
      sourceUrl || null,
      rawJson ? JSON.stringify(rawJson) : null,
    ],
  );

  return result.rows[0] || null;
}

async function getActivitiesByDate(userSlug, date) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      activity_date,
      time,
      source,
      activity_type,
      description,
      calories,
      distance_km,
      duration_min,
      steps,
      avg_speed_kmh,
      source_id,
      source_url,
      raw_json
    FROM activities
    WHERE user_id = $1
      AND activity_date = $2
    ORDER BY time ASC NULLS LAST, id ASC
    `,
    [userId, date],
  );

  return result.rows.map((row) => [
    formatPostgresDate(row.activity_date),
    row.time || "",
    row.source || "",
    row.activity_type,
    row.description || "",
    normalizePostgresCalories(row.calories),
    normalizePostgresMetric(row.distance_km),
    normalizePostgresMetric(row.duration_min),
    normalizePostgresMetric(row.steps),
    normalizePostgresMetric(row.avg_speed_kmh),
    row.source_id || "",
    row.source_url || "",
    row.raw_json || "",
  ]);
}

async function getActivitiesByDateRange(userSlug, startDate, endDate) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      activity_date,
      time,
      source,
      activity_type,
      description,
      calories,
      distance_km,
      duration_min,
      steps,
      avg_speed_kmh,
      source_id,
      source_url,
      raw_json
    FROM activities
    WHERE user_id = $1
      AND activity_date >= $2
      AND activity_date <= $3
    ORDER BY activity_date ASC, time ASC NULLS LAST, id ASC
    `,
    [userId, startDate, endDate],
  );

  return result.rows.map((row) => [
    formatPostgresDate(row.activity_date),
    row.time || "",
    row.source || "",
    row.activity_type,
    row.description || "",
    normalizePostgresCalories(row.calories),
    normalizePostgresMetric(row.distance_km),
    normalizePostgresMetric(row.duration_min),
    normalizePostgresMetric(row.steps),
    normalizePostgresMetric(row.avg_speed_kmh),
    row.source_id || "",
    row.source_url || "",
    row.raw_json || "",
  ]);
}

module.exports = {
  insertActivity,
  getActivitiesByDate,
  getActivitiesByDateRange,
};
