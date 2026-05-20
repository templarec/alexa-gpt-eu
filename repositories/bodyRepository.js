const { query } = require("../db/postgres");

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

module.exports = {
  insertBodyMetric,
};
