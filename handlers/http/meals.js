const { appendMealRow, getAllMeals, getTodayRows } = require("../../sheets");
const { analyzeMeal } = require("../../openai");
const { parseJsonBody, jsonResponse } = require("../../utils/http");

function calculateRunningTotalFromRows(rows) {
  return rows.reduce((sum, row) => {
    const calories = Number(row[4] || 0);
    return sum + calories;
  }, 0);
}

async function getTodayMealRows(date) {
  return await getTodayRows(date);
}

async function exportMeals() {
  const rows = await getAllMeals();
  return jsonResponse(200, rows);
}

async function createMealFromHttp(event, { date, time }) {
  const body = parseJsonBody(event);

  const mealType = String(body.meal_type || "").trim();
  const description = String(body.description || "").trim();
  const calories = Number(body.calories || 0);
  const protein = Number(body.protein || 0);
  const carbs = Number(body.carbs || 0);
  const fat = Number(body.fat || 0);

  if (!mealType || !description) {
    return jsonResponse(400, {
      error: "meal_type e description sono obbligatori"
    });
  }

  if (![calories, protein, carbs, fat].every((n) => Number.isFinite(n))) {
    return jsonResponse(400, {
      error: "calories, protein, carbs e fat devono essere numeri validi"
    });
  }

  const todayRows = await getTodayMealRows(date);
  const previousTotal = calculateRunningTotalFromRows(todayRows);
  const newTotal = previousTotal + calories;

  const row = [
    date,
    time,
    mealType,
    description,
    calories,
    protein,
    carbs,
    fat
  ];

  await appendMealRow(row);

  return jsonResponse(200, {
    success: true,
    saved: {
      date,
      time,
      meal_type: mealType,
      description,
      calories,
      protein,
      carbs,
      fat,
      running_total: newTotal
    }
  });
}

async function createAnalyzedMealFromHttp(event, { date, time }) {
  const body = parseJsonBody(event);

  const mealType = String(body.meal_type || "").trim();
  const description = String(body.description || "").trim();

  if (!mealType || !description) {
    return jsonResponse(400, {
      error: "meal_type e description sono obbligatori"
    });
  }

  try {
    const analysis = await analyzeMeal(mealType, description);

    if (!analysis || !analysis.total) {
      throw new Error("invalid_analysis_result");
    }

    if (analysis.missing_quantities) {
      return jsonResponse(400, {
        error: "Mancano quantità chiare nel testo. Specifica meglio grammi, numero di pezzi o ml.",
        analysis
      });
    }

    const todayRows = await getTodayMealRows(date);
    const previousTotal = calculateRunningTotalFromRows(todayRows);
    const calories = Number(analysis.total.calories || 0);
    const protein = Number(analysis.total.protein || 0);
    const carbs = Number(analysis.total.carbs || 0);
    const fat = Number(analysis.total.fat || 0);
    const newTotal = previousTotal + calories;

    const row = [
      date,
      time,
      analysis.meal_type || mealType,
      analysis.description_normalized || description,
      calories,
      protein,
      carbs,
      fat
    ];

    await appendMealRow(row);

    return jsonResponse(200, {
      success: true,
      saved: {
        date,
        time,
        meal_type: analysis.meal_type || mealType,
        description: analysis.description_normalized || description,
        calories,
        protein,
        carbs,
        fat,
        running_total: newTotal
      },
      analysis
    });
  } catch (error) {
    return jsonResponse(500, {
      error: "Errore durante analisi e salvataggio",
      details: String(error.message || error)
    });
  }
}

async function getMealsToday({ date }) {
  const rows = await getTodayMealRows(date);
  return jsonResponse(200, rows);
}

module.exports = {
  exportMeals,
  createMealFromHttp,
  createAnalyzedMealFromHttp,
  getMealsToday
};