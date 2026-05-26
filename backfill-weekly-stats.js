const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

const { getMeals } = require("./repositories/mealsRepository");
const { getWeekDietContext } = require("./services/weekContext");
const {
  upsertWeeklyStatsSnapshot,
} = require("./repositories/weeklyStatsRepository");

const BACKFILL_USER_ID = String(process.env.BACKFILL_USER_ID || DEFAULT_USER_ID)
  .trim()
  .toLowerCase();

function getMonday(dateString) {
  const date = new Date(dateString + "T00:00:00");
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);

  return date.toISOString().slice(0, 10);
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

async function main() {
  console.log(
    "WEEKLY BACKFILL START",
    JSON.stringify({ userId: BACKFILL_USER_ID }),
  );

  const meals = await getMeals({
    userSlug: BACKFILL_USER_ID,
    limit: 100000,
  });

  const uniqueDates = new Set();

  for (const meal of meals) {
    const date = normalizeDateString(meal.date);

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      uniqueDates.add(date);
    }
  }

  const uniqueWeeks = new Set();

  for (const date of uniqueDates) {
    uniqueWeeks.add(getMonday(date));
  }

  const sortedWeeks = [...uniqueWeeks].sort();

  console.log(
    "WEEKS FOUND",
    JSON.stringify({
      userId: BACKFILL_USER_ID,
      count: sortedWeeks.length,
      weeks: sortedWeeks,
    }),
  );

  for (const weekStart of sortedWeeks) {
    console.log(
      "PROCESSING WEEK",
      JSON.stringify({ userId: BACKFILL_USER_ID, weekStart }),
    );

    const context = await getWeekDietContext(weekStart, {
      userId: BACKFILL_USER_ID,
    });

    await upsertWeeklyStatsSnapshot({
      userSlug: BACKFILL_USER_ID,
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
      source: "backfill",
    });
  }

  console.log(
    "WEEKLY BACKFILL DONE",
    JSON.stringify({
      userId: BACKFILL_USER_ID,
      count: sortedWeeks.length,
    }),
  );
}

main().catch((err) => {
  console.error("WEEKLY BACKFILL FAILED", err);
  process.exit(1);
});
