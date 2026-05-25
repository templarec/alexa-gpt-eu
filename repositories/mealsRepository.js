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

function normalizePostgresMacro(value) {
  const number = parseSheetNumber(value);

  if (Math.abs(number) >= 100) {
    return number / 100;
  }

  return number;
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

function mapMealRow(row) {
  return {
    id: row.id,
    date: formatPostgresDate(row.date),
    time: row.time || "",
    meal_type: row.meal_type,
    description: row.description || "",
    calories: normalizePostgresCalories(row.calories),
    protein: normalizePostgresMacro(row.protein),
    carbs: normalizePostgresMacro(row.carbs),
    fat: normalizePostgresMacro(row.fat),
    source: row.source || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function getMealById(userSlug, mealId) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    SELECT
      id,
      date,
      time,
      meal_type,
      description,
      calories,
      protein,
      carbs,
      fat,
      source,
      created_at,
      updated_at
    FROM meals
    WHERE user_id = $1
      AND id = $2
    LIMIT 1
    `,
    [userId, mealId],
  );

  return result.rows[0] ? mapMealRow(result.rows[0]) : null;
}

async function getMeals({ userSlug, startDate, endDate, date, limit = 100 }) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const params = [userId];
  const where = ["user_id = $1"];

  if (date) {
    params.push(date);
    where.push(`date = $${params.length}`);
  } else {
    if (startDate) {
      params.push(startDate);
      where.push(`date >= $${params.length}`);
    }

    if (endDate) {
      params.push(endDate);
      where.push(`date <= $${params.length}`);
    }
  }

  params.push(safeLimit);

  const result = await query(
    `
    SELECT
      id,
      date,
      time,
      meal_type,
      description,
      calories,
      protein,
      carbs,
      fat,
      source,
      created_at,
      updated_at
    FROM meals
    WHERE ${where.join(" AND ")}
    ORDER BY date DESC, time DESC NULLS LAST, id DESC
    LIMIT $${params.length}
    `,
    params,
  );

  return result.rows.map(mapMealRow);
}

async function updateMeal(userSlug, mealId, updates) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const allowedFields = {
    date: "date",
    time: "time",
    meal_type: "meal_type",
    description: "description",
    calories: "calories",
    protein: "protein",
    carbs: "carbs",
    fat: "fat",
    source: "source",
  };

  const setClauses = [];
  const params = [userId, mealId];

  for (const [key, column] of Object.entries(allowedFields)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      continue;
    }

    params.push(updates[key]);
    setClauses.push(`${column} = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return getMealById(userSlug, mealId);
  }

  const result = await query(
    `
    UPDATE meals
    SET
      ${setClauses.join(",\n      ")},
      updated_at = NOW()
    WHERE user_id = $1
      AND id = $2
    RETURNING
      id,
      date,
      time,
      meal_type,
      description,
      calories,
      protein,
      carbs,
      fat,
      source,
      created_at,
      updated_at
    `,
    params,
  );

  return result.rows[0] ? mapMealRow(result.rows[0]) : null;
}

async function deleteMeal(userSlug, mealId) {
  const userId = await getUserIdBySlug(userSlug);

  if (!userId) {
    throw new Error(`User not found: ${userSlug}`);
  }

  const result = await query(
    `
    DELETE FROM meals
    WHERE user_id = $1
      AND id = $2
    RETURNING id
    `,
    [userId, mealId],
  );

  return result.rowCount > 0;
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
    formatPostgresDate(row.date),
    row.time || "",
    row.meal_type,
    row.description,
    normalizePostgresCalories(row.calories),
    normalizePostgresMacro(row.protein),
    normalizePostgresMacro(row.carbs),
    normalizePostgresMacro(row.fat),
  ]);
}

async function getMealsByDateRange(userSlug, startDate, endDate) {
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
      AND date >= $2
      AND date <= $3
    ORDER BY date ASC, time ASC NULLS LAST, id ASC
    `,
    [userId, startDate, endDate],
  );

  return result.rows.map((row) => [
    formatPostgresDate(row.date),
    row.time || "",
    row.meal_type,
    row.description,
    normalizePostgresCalories(row.calories),
    normalizePostgresMacro(row.protein),
    normalizePostgresMacro(row.carbs),
    normalizePostgresMacro(row.fat),
  ]);
}

module.exports = {
  insertMeal,
  getMealById,
  getMeals,
  updateMeal,
  deleteMeal,
  getMealsByDate,
  getMealsByDateRange,
};
