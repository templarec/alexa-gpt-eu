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
    ON CONFLICT (source_id)
    WHERE source_id IS NOT NULL
    DO NOTHING
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
    row.activity_date,
    row.time || "",
    row.source || "",
    row.activity_type,
    row.description || "",
    parseSheetNumber(row.calories),
    parseSheetNumber(row.distance_km),
    parseSheetNumber(row.duration_min),
    parseSheetNumber(row.steps),
    parseSheetNumber(row.avg_speed_kmh),
    row.source_id || "",
    row.source_url || "",
    row.raw_json || "",
  ]);
}

module.exports = {
  insertActivity,
  getActivitiesByDate,
};
