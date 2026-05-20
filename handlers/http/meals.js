const { appendMealRow, getAllMeals, getTodayRows } = require("../../sheets");
const { insertMeal } = require("../../repositories/mealsRepository");
const { analyzeMeal } = require("../../openai");
const { parseJsonBody, jsonResponse } = require("../../utils/http");

function isIsoDateLike(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function hasUserIdColumn(row) {
  return !isIsoDateLike(row?.[0]) && isIsoDateLike(row?.[1]);
}

function getMealCalories(row) {
  const offset = hasUserIdColumn(row) ? 1 : 0;
  return Number(row[offset + 4] || 0);
}

function calculateRunningTotalFromRows(rows) {
  return rows.reduce((sum, row) => sum + getMealCalories(row), 0);
}

async function getTodayMealRows(date, userId) {
  return await getTodayRows(date, userId);
}

async function exportMeals({ userId } = {}) {
  const rows = await getAllMeals();

  if (!userId) {
    return jsonResponse(200, rows);
  }

  const normalizedUserId = String(userId).trim().toLowerCase();

  const filteredRows = rows.filter((row, index) => {
    if (index === 0) return true;

    if (!hasUserIdColumn(row)) {
      return normalizedUserId === "lorenzo";
    }

    return (
      String(row[0] || "")
        .trim()
        .toLowerCase() === normalizedUserId
    );
  });

  return jsonResponse(200, filteredRows);
}

async function createMealFromHttp(event, { date, time, userId = "lorenzo" }) {
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

  const normalizedUserId = String(userId).trim().toLowerCase() || "lorenzo";
  const todayRows = await getTodayMealRows(date, normalizedUserId);
  const previousTotal = calculateRunningTotalFromRows(todayRows);
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

  await appendMealRow(row);

  try {
    await insertMeal({
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
    });
  }

  return jsonResponse(200, {
    success: true,
    saved: {
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
  { date, time, userId = "lorenzo" },
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

    const normalizedUserId = String(userId).trim().toLowerCase() || "lorenzo";
    const todayRows = await getTodayMealRows(date, normalizedUserId);
    const previousTotal = calculateRunningTotalFromRows(todayRows);
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

    await appendMealRow(row);

    try {
      await insertMeal({
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
      });
    }

    return jsonResponse(200, {
      success: true,
      saved: {
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

async function getMealsToday({ date, userId = "lorenzo" }) {
  const normalizedUserId = String(userId).trim().toLowerCase() || "lorenzo";
  const rows = await getTodayMealRows(date, normalizedUserId);
  return jsonResponse(200, rows);
}

module.exports = {
  exportMeals,
  createMealFromHttp,
  createAnalyzedMealFromHttp,
  getMealsToday,
};
