require("dotenv").config();

const { getMeals } = require("./repositories/mealsRepository");
const { getWeekDietContext } = require("./services/weekContext");
const {
  upsertWeeklyStatsSnapshot,
} = require("./repositories/weeklyStatsRepository");

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

const DEBUG_USER_ID = String(process.env.DEBUG_USER_ID || DEFAULT_USER_ID)
  .trim()
  .toLowerCase();

function normalizeDateString(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim().slice(0, 10);
}

function getMonday(dateString) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const meals = await getMeals({
    userSlug: DEBUG_USER_ID,
    limit: 100000,
  });

  console.log("USER:", DEBUG_USER_ID);
  console.log("MEALS TOTAL:", meals.length);
  console.log("FIRST 5 MEALS:", JSON.stringify(meals.slice(0, 5), null, 2));

  const dates = meals
    .map((meal) => normalizeDateString(meal.date))
    .filter(Boolean);

  console.log("DATES FOUND:", dates.length);
  console.log("FIRST 10 DATES:", dates.slice(0, 10));

  const weeks = [...new Set(dates.map(getMonday))].sort();

  console.log("WEEKS FOUND:", weeks.length);
  console.log("WEEKS:", weeks);

  if (weeks.length === 0) return;

  const context = await getWeekDietContext(weeks[0], {
    userId: DEBUG_USER_ID,
  });

  console.log(
    "FIRST CONTEXT:",
    JSON.stringify(
      {
        user_id: context.user_id,
        week_start: context.week_start,
        week_end: context.week_end,
        summary: context.summary,
      },
      null,
      2,
    ),
  );

  const result = await upsertWeeklyStatsSnapshot({
    userSlug: DEBUG_USER_ID,
    weekStart: context.week_start,
    weekEnd: context.week_end,
    intake: context.summary.intake,
    activity: context.summary.activity,
    net: context.summary.net,
    target: context.summary.target,
    remaining: context.summary.remaining,
    protein: context.summary.protein,
    carbs: context.summary.carbs,
    fat: context.summary.fat,
    recentMealsJson: context.recent_meals || [],
    foodFrequencyJson: context.food_frequency || {},
    varietyWarningsJson: context.variety_warnings || [],
    generatedAt: new Date().toISOString(),
    source: "debug",
  });

  console.log("UPSERT RESULT:", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
