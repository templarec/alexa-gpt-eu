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

async function insertMeal({
  userSlug,
  date,
  time,
  mealType,
  description,
  calories,
  protein,
  carbs,
  fat,
  source,
}) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    INSERT INTO meals (
      user_id,
      date,
      time,
      meal_type,
      description,
      calories,
      protein,
      carbs,
      fat,
      source
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
    )
    RETURNING id
    `,
    [
      userId,
      date,
      time || null,
      mealType,
      description,
      Number(calories || 0),
      Number(protein || 0),
      Number(carbs || 0),
      Number(fat || 0),
      source || null,
    ],
  );

  return result.rows[0];
}

async function getMealsByDate(userSlug, date) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      date,
      time,
      meal_type,
      description,
      calories,
      protein,
      carbs,
      fat
    FROM meals
    WHERE user_id = $1
      AND date = $2
    ORDER BY time ASC NULLS LAST, id ASC
    `,
    [userId, date],
  );

  return result.rows.map((row) => [
    row.date,
    row.time || "",
    row.meal_type,
    row.description,
    parseSheetNumber(row.calories),
    parseSheetNumber(row.protein),
    parseSheetNumber(row.carbs),
    parseSheetNumber(row.fat),
  ]);
}

module.exports = {
  insertMeal,
  getMealsByDate,
};
