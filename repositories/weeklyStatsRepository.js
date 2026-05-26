const { query } = require("../db/postgres");
const { getUserIdBySlug } = require("./usersRepository");

async function upsertWeeklyStatsSnapshot({
  userSlug,
  weekStart,
  weekEnd,
  intake,
  activity,
  net,
  target,
  remaining,
  protein,
  carbs,
  fat,
  recentMealsJson,
  foodFrequencyJson,
  varietyWarningsJson,
  generatedAt,
  source,
}) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`Unknown user slug: ${userSlug}`);
  }

  const result = await query(
    `
    INSERT INTO weekly_stats (
      user_id,
      week_start,
      week_end,
      intake,
      activity,
      net,
      target,
      remaining,
      protein,
      carbs,
      fat,
      recent_meals_json,
      food_frequency_json,
      variety_warnings_json,
      generated_at,
      source,
      updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,NOW()
    )
    ON CONFLICT (user_id, week_start)
    DO UPDATE SET
      week_end = EXCLUDED.week_end,
      intake = EXCLUDED.intake,
      activity = EXCLUDED.activity,
      net = EXCLUDED.net,
      target = EXCLUDED.target,
      remaining = EXCLUDED.remaining,
      protein = EXCLUDED.protein,
      carbs = EXCLUDED.carbs,
      fat = EXCLUDED.fat,
      recent_meals_json = EXCLUDED.recent_meals_json,
      food_frequency_json = EXCLUDED.food_frequency_json,
      variety_warnings_json = EXCLUDED.variety_warnings_json,
      generated_at = EXCLUDED.generated_at,
      source = EXCLUDED.source,
      updated_at = NOW()
    RETURNING *
    `,
    [
      userId,
      weekStart,
      weekEnd,
      intake,
      activity,
      net,
      target,
      remaining,
      protein,
      carbs,
      fat,
      JSON.stringify(recentMealsJson || []),
      JSON.stringify(foodFrequencyJson || {}),
      JSON.stringify(varietyWarningsJson || []),
      generatedAt || new Date().toISOString(),
      source || "runtime",
    ],
  );

  return result.rows[0] || null;
}

async function getWeeklyStats({ userSlug, weekStart }) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`Unknown user slug: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT *
    FROM weekly_stats
    WHERE user_id = $1
      AND week_start = $2
    LIMIT 1
    `,
    [userId, weekStart],
  );

  return result.rows[0] || null;
}

module.exports = {
  upsertWeeklyStatsSnapshot,
  getWeeklyStats,
};
