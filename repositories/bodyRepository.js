const { query } = require("../db/postgres");
const { maybeDecryptBodyNumber } = require("../utils/crypto");

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

async function insertBodyMetric({
  userSlug,
  date,
  time,
  source,
  weight,
  bodyFat,
  muscleMass,
  waterMass,
  fatMass,
  leanMass,
  rawJson,
}) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    INSERT INTO body_metrics (
      user_id,
      date,
      time,
      source,
      weight,
      body_fat,
      muscle_mass,
      water_mass,
      fat_mass,
      lean_mass,
      raw_json
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
    )
    RETURNING id
    `,
    [
      userId,
      date,
      time || null,
      source || null,
      weight ?? null,
      bodyFat ?? null,
      muscleMass ?? null,
      waterMass ?? null,
      fatMass ?? null,
      leanMass ?? null,
      rawJson ? JSON.stringify(rawJson) : null,
    ],
  );

  return result.rows[0];
}

async function getLatestBodyMetric(userSlug) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      bm.date,
      bm.time,
      bm.source,
      bm.weight,
      bm.body_fat,
      bm.muscle_mass,
      bm.water_mass,
      bm.fat_mass,
      bm.lean_mass,
      bm.raw_json
    FROM body_metrics bm
    WHERE bm.user_id = $1
    ORDER BY bm.date DESC, bm.time DESC, bm.created_at DESC
    LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

async function getLatestWeightFromPostgres(userSlug) {
  const latest = await getLatestBodyMetric(userSlug);

  if (!latest || latest.weight == null || latest.weight === "") {
    return null;
  }

  const decryptedWeight = maybeDecryptBodyNumber(latest.weight);
  const parsedWeight = Number(String(decryptedWeight).replace(",", "."));

  return Number.isFinite(parsedWeight) ? parsedWeight : null;
}

async function getBodyMetricsByDateRange(userSlug, startDate, endDate) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      bm.date,
      bm.time,
      bm.source,
      bm.weight,
      bm.body_fat,
      bm.muscle_mass,
      bm.water_mass,
      bm.fat_mass,
      bm.lean_mass,
      bm.raw_json
    FROM body_metrics bm
    WHERE bm.user_id = $1
      AND bm.date >= $2
      AND bm.date <= $3
    ORDER BY bm.date ASC, bm.time ASC NULLS LAST, bm.created_at ASC
    `,
    [userId, startDate, endDate],
  );

  return result.rows.map((row) => ({
    date:
      row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10),
    time: row.time || "",
    source: row.source || "",
    weight: maybeDecryptBodyNumber(row.weight),
    body_fat: maybeDecryptBodyNumber(row.body_fat),
    muscle_mass: maybeDecryptBodyNumber(row.muscle_mass),
    water_mass: maybeDecryptBodyNumber(row.water_mass),
    fat_mass: maybeDecryptBodyNumber(row.fat_mass),
    lean_mass: maybeDecryptBodyNumber(row.lean_mass),
    raw_json: row.raw_json || null,
  }));
}

module.exports = {
  insertBodyMetric,
  getLatestBodyMetric,
  getLatestWeightFromPostgres,
  getBodyMetricsByDateRange,
};
