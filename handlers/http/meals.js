const { appendMealRow } = require("../../sheets");
const {
  insertMeal,
  getMealById,
  getMeals,
  updateMeal,
  deleteMeal,
} = require("../../repositories/mealsRepository");
const { analyzeMeal } = require("../../openai");
const { parseJsonBody, jsonResponse } = require("../../utils/http");

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

function normalizeUserId(userId) {
  return (
    String(userId || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
}

function calculateRunningTotalFromMeals(meals) {
  return meals.reduce((sum, meal) => {
    const calories = Number(meal.calories || 0);
    return sum + calories;
  }, 0);
}

async function exportMeals({ userId } = {}) {
  const normalizedUserId = normalizeUserId(userId);

  const meals = await getMeals({
    userSlug: normalizedUserId,
  });

  return jsonResponse(200, {
    success: true,
    meals,
  });
}

async function createMealFromHttp(
  event,
  { date, time, userId = DEFAULT_USER_ID },
) {
  const body = parseJsonBody(event);

  const mealType = String(body.meal_type || "").trim();
  const description = String(body.description || "").trim();
  const calories = Number(body.calories || 0);
  const protein = Number(body.protein || 0);
  const carbs = Number(body.carbs || 0);
  const fat = Number(body.fat || 0);

  if (!mealType || !description) {
    return jsonResponse(400, {
      error: "meal_type e description sono obbligatori",
    });
  }

  if (![calories, protein, carbs, fat].every((n) => Number.isFinite(n))) {
    return jsonResponse(400, {
      error: "calories, protein, carbs e fat devono essere numeri validi",
    });
  }

  const normalizedUserId = normalizeUserId(userId);
  const todayMeals = await getMeals({
    userSlug: normalizedUserId,
    date,
  });
  const previousTotal = calculateRunningTotalFromMeals(todayMeals);
  const newTotal = previousTotal + calories;

  const row = [
    normalizedUserId,
    date,
    time,
    mealType,
    description,
    calories,
    protein,
    carbs,
    fat,
  ];

  let insertedMeal = null;

  try {
    insertedMeal = await insertMeal({
      userSlug: normalizedUserId,
      date,
      time,
      mealType,
      description,
      calories,
      protein,
      carbs,
      fat,
      source: body.source || "api",
    });

    console.log("POSTGRES MEAL INSERTED");
  } catch (error) {
    console.error("POSTGRES MEAL INSERT FAILED", {
      message: error.message,
      userId: normalizedUserId,
      date,
      mealType,
    });

    return jsonResponse(500, {
      success: false,
      error: "postgres_meal_write_failed",
    });
  }

  try {
    await appendMealRow(row);
  } catch (error) {
    console.error("SHEETS MEAL SHADOW WRITE FAILED", {
      message: error.message,
      userId: normalizedUserId,
      date,
      mealType,
    });
  }

  return jsonResponse(200, {
    success: true,
    saved: {
      id: insertedMeal?.id || null,
      user_id: normalizedUserId,
      date,
      time,
      meal_type: mealType,
      description,
      calories,
      protein,
      carbs,
      fat,
      running_total: newTotal,
    },
  });
}

async function createAnalyzedMealFromHttp(
  event,
  { date, time, userId = DEFAULT_USER_ID },
) {
  const body = parseJsonBody(event);

  const mealType = String(body.meal_type || "").trim();
  const description = String(body.description || "").trim();

  if (!mealType || !description) {
    return jsonResponse(400, {
      error: "meal_type e description sono obbligatori",
    });
  }

  try {
    const analysis = await analyzeMeal(mealType, description);

    if (!analysis || !analysis.total) {
      throw new Error("invalid_analysis_result");
    }

    if (analysis.missing_quantities) {
      return jsonResponse(400, {
        error:
          "Mancano quantità chiare nel testo. Specifica meglio grammi, numero di pezzi o ml.",
        analysis,
      });
    }

    const normalizedUserId = normalizeUserId(userId);
    const todayMeals = await getMeals({
      userSlug: normalizedUserId,
      date,
    });
    const previousTotal = calculateRunningTotalFromMeals(todayMeals);
    const calories = Number(analysis.total.calories || 0);
    const protein = Number(analysis.total.protein || 0);
    const carbs = Number(analysis.total.carbs || 0);
    const fat = Number(analysis.total.fat || 0);
    const newTotal = previousTotal + calories;

    const row = [
      normalizedUserId,
      date,
      time,
      analysis.meal_type || mealType,
      analysis.description_normalized || description,
      calories,
      protein,
      carbs,
      fat,
    ];

    let insertedMeal = null;

    try {
      insertedMeal = await insertMeal({
        userSlug: normalizedUserId,
        date,
        time,
        mealType: analysis.meal_type || mealType,
        description: analysis.description_normalized || description,
        calories,
        protein,
        carbs,
        fat,
        source: body.source || "analyze",
      });

      console.log("POSTGRES MEAL INSERTED");
    } catch (error) {
      console.error("POSTGRES MEAL INSERT FAILED", {
        message: error.message,
        userId: normalizedUserId,
        date,
        mealType: analysis.meal_type || mealType,
      });

      return jsonResponse(500, {
        success: false,
        error: "postgres_meal_write_failed",
      });
    }

    try {
      await appendMealRow(row);
    } catch (error) {
      console.error("SHEETS MEAL SHADOW WRITE FAILED", {
        message: error.message,
        userId: normalizedUserId,
        date,
        mealType: analysis.meal_type || mealType,
      });
    }

    return jsonResponse(200, {
      success: true,
      saved: {
        id: insertedMeal?.id || null,
        user_id: normalizedUserId,
        date,
        time,
        meal_type: analysis.meal_type || mealType,
        description: analysis.description_normalized || description,
        calories,
        protein,
        carbs,
        fat,
        running_total: newTotal,
      },
      analysis,
    });
  } catch (error) {
    return jsonResponse(500, {
      error: "Errore durante analisi e salvataggio",
      details: String(error.message || error),
    });
  }
}

async function getMealsToday({ date, userId = DEFAULT_USER_ID }) {
  const normalizedUserId = normalizeUserId(userId);

  const meals = await getMeals({
    userSlug: normalizedUserId,
    date,
  });

  return jsonResponse(200, {
    success: true,
    meals,
  });
}

function getMealIdFromPath(path) {
  const match = String(path || "").match(/\/meals\/([^/]+)$/);
  return match ? match[1] : null;
}

function normalizeOptionalNumber(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : NaN;
}

async function getMealsFromHttp(event, { userId = DEFAULT_USER_ID } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const queryParams = event.queryStringParameters || {};

  const meals = await getMeals({
    userSlug: normalizedUserId,
    date: queryParams.date,
    startDate: queryParams.start_date,
    endDate: queryParams.end_date,
    limit: queryParams.limit,
  });

  return jsonResponse(200, {
    success: true,
    meals,
  });
}

async function getMealFromHttp(event, { userId = DEFAULT_USER_ID } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const mealId = getMealIdFromPath(event.rawPath || event.path);

  if (!mealId) {
    return jsonResponse(400, {
      success: false,
      error: "meal_id_required",
    });
  }

  const meal = await getMealById(normalizedUserId, mealId);

  if (!meal) {
    return jsonResponse(404, {
      success: false,
      error: "meal_not_found",
    });
  }

  return jsonResponse(200, {
    success: true,
    meal,
  });
}

async function updateMealFromHttp(event, { userId = DEFAULT_USER_ID } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const mealId = getMealIdFromPath(event.rawPath || event.path);

  if (!mealId) {
    return jsonResponse(400, {
      success: false,
      error: "meal_id_required",
    });
  }

  const body = parseJsonBody(event);
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "date")) {
    updates.date = String(body.date || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "time")) {
    updates.time = body.time === null ? null : String(body.time || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "meal_type")) {
    updates.meal_type = String(body.meal_type || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    updates.description = String(body.description || "").trim();
  }

  for (const field of ["calories", "protein", "carbs", "fat"]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      continue;
    }

    const value = normalizeOptionalNumber(body[field]);

    if (Number.isNaN(value)) {
      return jsonResponse(400, {
        success: false,
        error: `${field}_must_be_number`,
      });
    }

    updates[field] = value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "source")) {
    updates.source =
      body.source === null ? null : String(body.source || "").trim();
  }

  const meal = await updateMeal(normalizedUserId, mealId, updates);

  if (!meal) {
    return jsonResponse(404, {
      success: false,
      error: "meal_not_found",
    });
  }

  return jsonResponse(200, {
    success: true,
    meal,
  });
}

async function deleteMealFromHttp(event, { userId = DEFAULT_USER_ID } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const mealId = getMealIdFromPath(event.rawPath || event.path);

  if (!mealId) {
    return jsonResponse(400, {
      success: false,
      error: "meal_id_required",
    });
  }

  const deleted = await deleteMeal(normalizedUserId, mealId);

  if (!deleted) {
    return jsonResponse(404, {
      success: false,
      error: "meal_not_found",
    });
  }

  return jsonResponse(200, {
    success: true,
    deleted: true,
    id: mealId,
  });
}

module.exports = {
  exportMeals,
  createMealFromHttp,
  createAnalyzedMealFromHttp,
  getMealsToday,
  getMealsFromHttp,
  getMealFromHttp,
  updateMealFromHttp,
  deleteMealFromHttp,
};
