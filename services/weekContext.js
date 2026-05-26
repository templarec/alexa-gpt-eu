const { getMeals } = require("../repositories/mealsRepository");
const {
  getActivitiesByDateRange,
} = require("../repositories/activityRepository");
const {
  getUserConfigValueFromPostgres,
} = require("../repositories/configRepository");
const {
  buildNormalizedActivityEntries,
} = require("../utils/activity-normalizer");
const { roundNumber } = require("../utils/numbers-and-dates");

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

function getWeekRangeMondaySunday(referenceDate) {
  const date = new Date(`${referenceDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    week_start: monday.toISOString().slice(0, 10),
    week_end: sunday.toISOString().slice(0, 10),
  };
}

function isDateInRange(date, startDate, endDate) {
  return date >= startDate && date <= endDate;
}

function getDatesInRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function normalizeMeal(meal) {
  return {
    id: meal.id,
    date: normalizeDateString(meal.date),
    time: meal.time || "",
    meal_type: meal.meal_type || meal.mealType || "",
    description: meal.description || "",
    calories: Number(meal.calories || 0),
    protein: Number(meal.protein || 0),
    carbs: Number(meal.carbs || 0),
    fat: Number(meal.fat || 0),
    source: meal.source || null,
  };
}

function countIfDescriptionIncludes(meals, patterns) {
  return meals.filter((meal) => {
    const text = String(meal.description || "").toLowerCase();
    return patterns.some((pattern) => text.includes(pattern));
  }).length;
}

function buildFoodFrequency(meals) {
  return {
    uova: countIfDescriptionIncludes(meals, ["uovo", "uova"]),
    yogurt_greco: countIfDescriptionIncludes(meals, ["yogurt greco"]),
    yogurt: countIfDescriptionIncludes(meals, ["yogurt"]),
    tonno: countIfDescriptionIncludes(meals, ["tonno"]),
    pollo: countIfDescriptionIncludes(meals, ["pollo"]),
    tacchino: countIfDescriptionIncludes(meals, ["tacchino"]),
    carne_rossa: countIfDescriptionIncludes(meals, [
      "manzo",
      "bovino",
      "hamburger",
      "carne rossa",
    ]),
    pesce: countIfDescriptionIncludes(meals, [
      "pesce",
      "salmone",
      "merluzzo",
      "orata",
      "branzino",
      "sgombro",
    ]),
    fiocchi_di_latte: countIfDescriptionIncludes(meals, ["fiocchi di latte"]),
    latte: countIfDescriptionIncludes(meals, ["latte"]),
    mozzarella: countIfDescriptionIncludes(meals, ["mozzarella"]),
    pasta: countIfDescriptionIncludes(meals, ["pasta"]),
    riso: countIfDescriptionIncludes(meals, ["riso", "risotto"]),
    piadina: countIfDescriptionIncludes(meals, ["piadina"]),
    pane: countIfDescriptionIncludes(meals, ["pane", "pancarr", "toast"]),
    patate: countIfDescriptionIncludes(meals, ["patata", "patate"]),
    banana: countIfDescriptionIncludes(meals, ["banana"]),
    mela: countIfDescriptionIncludes(meals, ["mela", "mele"]),
  };
}

function buildVarietyWarnings(foodFrequency) {
  const warnings = [];

  if ((foodFrequency.uova || 0) >= 4) {
    warnings.push(
      "Uova già frequenti questa settimana: evita di proporle se ci sono alternative.",
    );
  }

  if ((foodFrequency.tonno || 0) >= 2) {
    warnings.push(
      "Tonno già presente più volte questa settimana: preferisci altre proteine.",
    );
  }

  if ((foodFrequency.yogurt_greco || 0) >= 3) {
    warnings.push(
      "Yogurt greco già frequente questa settimana: varia lo spuntino se possibile.",
    );
  }

  if ((foodFrequency.pollo || 0) >= 3) {
    warnings.push(
      "Pollo già frequente questa settimana: valuta pesce, legumi o latticini magri.",
    );
  }

  if ((foodFrequency.piadina || 0) >= 3) {
    warnings.push(
      "Piadina già frequente questa settimana: alterna con pane, riso, patate o pasta.",
    );
  }

  return warnings;
}

async function getManualTarget(userId) {
  const value = await getUserConfigValueFromPostgres(
    userId,
    "diet_target_manual",
  );
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1750;
}

function buildDaySummary({ date, meals, activities, target }) {
  const dayMeals = meals.filter((meal) => meal.date === date);
  const dayActivities = activities.filter((activity) => activity.date === date);

  const intake = dayMeals.reduce(
    (sum, meal) => sum + Number(meal.calories || 0),
    0,
  );
  const activity = dayActivities.reduce(
    (sum, item) => sum + Number(item.calories || 0),
    0,
  );
  const net = intake + activity;
  const protein = dayMeals.reduce(
    (sum, meal) => sum + Number(meal.protein || 0),
    0,
  );
  const carbs = dayMeals.reduce(
    (sum, meal) => sum + Number(meal.carbs || 0),
    0,
  );
  const fat = dayMeals.reduce((sum, meal) => sum + Number(meal.fat || 0), 0);

  return {
    date,
    intake: roundNumber(intake),
    activity: roundNumber(activity),
    net: roundNumber(net),
    target: roundNumber(target),
    remaining: roundNumber(target - net),
    protein: roundNumber(protein),
    carbs: roundNumber(carbs),
    fat: roundNumber(fat),
    meals_count: dayMeals.length,
    activities_count: dayActivities.length,
  };
}

async function getWeekDietContext(referenceDate, options = {}) {
  const userId = normalizeUserId(options.userId);
  const { week_start, week_end } = getWeekRangeMondaySunday(referenceDate);
  const manualTarget = await getManualTarget(userId);

  const rawMeals = await getMeals({
    userSlug: userId,
    startDate: week_start,
    endDate: week_end,
    limit: 100000,
  });

  const rawActivities = await getActivitiesByDateRange(
    userId,
    week_start,
    week_end,
  );

  const meals = rawMeals
    .map(normalizeMeal)
    .filter((meal) => isDateInRange(meal.date, week_start, week_end));

  const activities = buildNormalizedActivityEntries(rawActivities)
    .map((activity) => ({
      ...activity,
      date: normalizeDateString(activity.date),
    }))
    .filter((activity) => isDateInRange(activity.date, week_start, week_end));

  const dates = getDatesInRange(week_start, week_end);
  const days = dates.map((date) =>
    buildDaySummary({
      date,
      meals,
      activities,
      target: manualTarget,
    }),
  );

  const summary = days.reduce(
    (acc, day) => ({
      intake: acc.intake + day.intake,
      activity: acc.activity + day.activity,
      net: acc.net + day.net,
      target: acc.target + day.target,
      remaining: acc.remaining + day.remaining,
      protein: acc.protein + day.protein,
      carbs: acc.carbs + day.carbs,
      fat: acc.fat + day.fat,
    }),
    {
      intake: 0,
      activity: 0,
      net: 0,
      target: 0,
      remaining: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    },
  );

  const foodFrequency = buildFoodFrequency(meals);
  const varietyWarnings = buildVarietyWarnings(foodFrequency);

  const recentMeals = [...meals]
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .slice(0, 20);

  return {
    user_id: userId,
    week_start,
    week_end,
    summary: {
      intake: roundNumber(summary.intake),
      activity: roundNumber(summary.activity),
      net: roundNumber(summary.net),
      target: roundNumber(summary.target),
      remaining: roundNumber(summary.remaining),
      protein: roundNumber(summary.protein),
      carbs: roundNumber(summary.carbs),
      fat: roundNumber(summary.fat),
    },
    days,
    recent_meals: recentMeals,
    food_frequency: foodFrequency,
    variety_warnings: varietyWarnings,
  };
}

module.exports = {
  getWeekDietContext,
  getWeekRangeMondaySunday,
  buildFoodFrequency,
  buildVarietyWarnings,
};
