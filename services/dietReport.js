const { getMeals } = require("../repositories/mealsRepository");
const { getActivitiesByDate } = require("../repositories/activityRepository");
const { getLatestBodyMetric } = require("../repositories/bodyRepository");
const {
  getUserConfigValueFromPostgres,
} = require("../repositories/configRepository");
const {
  upsertDailyStatsSnapshot,
} = require("../repositories/dailyStatsRepository");
const {
  buildNormalizedActivityEntries,
} = require("../utils/activity-normalizer");
const { roundNumber } = require("../utils/numbers-and-dates");
const { getDynamicTdee } = require("../utils/tdee");

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "lorenzo";

function normalizeUserId(value) {
  return String(value || DEFAULT_USER_ID)
    .trim()
    .toLowerCase();
}

function normalizeDateString(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim().slice(0, 10);
}

function parseConfigNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getUserConfigValue(key, userId) {
  return await getUserConfigValueFromPostgres(userId, key);
}

async function resolveDietTarget({ userId, targetCalories, finalTdee }) {
  if (targetCalories !== null && targetCalories !== undefined) {
    return Number(targetCalories);
  }

  const mode =
    String((await getUserConfigValue("diet_target_mode", userId)) || "manual")
      .trim()
      .toLowerCase() || "manual";

  const manualTarget = parseConfigNumber(
    await getUserConfigValue("diet_target_manual", userId),
    1750,
  );

  const deficit = parseConfigNumber(
    await getUserConfigValue("diet_deficit_kcal", userId),
    700,
  );

  if (mode === "dynamic" && Number.isFinite(Number(finalTdee))) {
    return Math.round(Number(finalTdee) - deficit);
  }

  return manualTarget;
}

async function getTodayDietReport(
  todayDate,
  targetCalories = null,
  options = {},
) {
  const userId = normalizeUserId(options.userId);
  const skipDailyStatsSnapshot = Boolean(options.skipDailyStatsSnapshot);

  const meals = await getMeals({
    userSlug: userId,
    date: todayDate,
    limit: 100000,
  });

  const activityRows = await getActivitiesByDate({
    userSlug: userId,
    date: todayDate,
  });

  const activityEntries = buildNormalizedActivityEntries(activityRows);

  const mealEntries = meals.map((meal, index) => {
    const calories = Number(meal.calories || 0);

    return {
      id: meal.id,
      date: normalizeDateString(meal.date),
      time: meal.time || "",
      meal_type: meal.meal_type || meal.mealType || "",
      description: meal.description || "",
      calories,
      protein: Number(meal.protein || 0),
      carbs: Number(meal.carbs || 0),
      fat: Number(meal.fat || 0),
      source: meal.source || null,
      running_total: meals
        .slice(0, index + 1)
        .reduce((sum, item) => sum + Number(item.calories || 0), 0),
    };
  });

  let intake = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;

  for (const meal of mealEntries) {
    intake += Number(meal.calories || 0);
    protein += Number(meal.protein || 0);
    carbs += Number(meal.carbs || 0);
    fat += Number(meal.fat || 0);
  }

  const activity = activityEntries.reduce(
    (sum, entry) => sum + Number(entry.calories || 0),
    0,
  );

  const net = intake + activity;

  const latestBody = await getLatestBodyMetric({ userSlug: userId });
  const fallbackWeightKg = Number(
    latestBody?.weight || process.env.USER_WEIGHT_KG || 95,
  );
  const fallbackSex = await getUserConfigValue("user_sex", userId);
  const fallbackAge = parseConfigNumber(
    await getUserConfigValue("user_age", userId),
    40,
  );
  const fallbackHeightCm = parseConfigNumber(
    await getUserConfigValue("user_height_cm", userId),
    175,
  );
  const fallbackBaseActivityFactor = parseConfigNumber(
    await getUserConfigValue("base_activity_factor", userId),
    1.2,
  );

  const tdee = await getDynamicTdee({
    todayActivityKcal: activity,
    todayDate,
    userId,
    fallbackWeightKg,
    fallbackSex,
    fallbackAge,
    fallbackHeightCm,
    fallbackBaseActivityFactor,
    getConfigValue: (key) => getUserConfigValue(key, userId),
  });

  const target = await resolveDietTarget({
    userId,
    targetCalories,
    finalTdee: tdee.finalTdee,
  });

  const remaining = target - net;

  const summary = {
    intake: roundNumber(intake),
    activity: roundNumber(activity),
    net: roundNumber(net),
    protein: roundNumber(protein),
    carbs: roundNumber(carbs),
    fat: roundNumber(fat),
    target: roundNumber(target),
    remaining: roundNumber(remaining),
    deficit: roundNumber(remaining),
    tdee_formula: tdee.formulaTdee ?? null,
    tdee_adaptive: tdee.adaptiveTdee ?? null,
    tdee_adaptive_raw: tdee.adaptiveTdeeRaw ?? null,
    tdee_adaptive_filtered: tdee.adaptiveTdeeFiltered ?? null,
    tdee_adaptive_capped: tdee.adaptiveTdeeCapped ?? false,
    tdee_adaptive_suspicious: tdee.adaptiveTdeeSuspicious ?? false,
    tdee: tdee.finalTdee ?? null,
  };

  if (!skipDailyStatsSnapshot) {
    await upsertDailyStatsSnapshot({
      userSlug: userId,
      date: todayDate,
      intake: summary.intake,
      activity: summary.activity,
      net: summary.net,
      target: summary.target,
      remaining: summary.remaining,
      protein: summary.protein,
      carbs: summary.carbs,
      fat: summary.fat,
      weight: latestBody?.weight ?? null,
      bodyFat: latestBody?.body_fat ?? latestBody?.bodyFat ?? null,
      tdeeFormula: summary.tdee_formula,
      tdeeAdaptive: summary.tdee_adaptive,
      tdeeFinal: summary.tdee,
      notes: null,
      source: "runtime",
    });
  }

  return {
    date: todayDate,
    user_id: userId,
    summary,
    meals: mealEntries,
    activities: activityEntries,
  };
}

module.exports = {
  getTodayDietReport,
};
