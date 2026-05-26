const { query } = require("../db/postgres");

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function upsertDailyStatsSnapshot(userSlug, data) {
  const result = await query(
    `
    INSERT INTO daily_stats (
      user_id,
      date,
      intake,
      activity,
      net,
      target,
      remaining,
      protein,
      carbs,
      fat,
      weight,
      body_fat,
      tdee_formula,
      tdee_adaptive,
      tdee_final,
      source,
      generated_at,
      updated_at
    )
    SELECT
      u.id,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16,
      NOW(),
      NOW()
    FROM users u
    WHERE u.slug = $1
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      intake = EXCLUDED.intake,
      activity = EXCLUDED.activity,
      net = EXCLUDED.net,
      target = EXCLUDED.target,
      remaining = EXCLUDED.remaining,
      protein = EXCLUDED.protein,
      carbs = EXCLUDED.carbs,
      fat = EXCLUDED.fat,
      weight = EXCLUDED.weight,
      body_fat = EXCLUDED.body_fat,
      tdee_formula = EXCLUDED.tdee_formula,
      tdee_adaptive = EXCLUDED.tdee_adaptive,
      tdee_final = EXCLUDED.tdee_final,
      source = EXCLUDED.source,
      generated_at = NOW(),
      updated_at = NOW()
    RETURNING id
    `,
    [
      userSlug,
      data.date,
      data.intake,
      data.activity,
      data.net,
      data.target,
      data.remaining,
      data.protein,
      data.carbs,
      data.fat,
      toNullableNumber(data.weight),
      toNullableNumber(data.bodyFat),
      toNullableNumber(data.tdeeFormula),
      toNullableNumber(data.tdeeAdaptive),
      toNullableNumber(data.tdeeFinal),
      data.source || "runtime",
    ],
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userSlug}`);
  }

  return {
    success: true,
  };
}

module.exports = {
  upsertDailyStatsSnapshot,
};
