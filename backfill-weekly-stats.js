const {
  getAllMeals,
  getWeekDietContext,
  upsertWeeklyStatsRow,
} = require("./sheets");

const DEFAULT_USER_ID = "lorenzo";
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

function normalizeUserId(value) {
  return String(value || DEFAULT_USER_ID)
    .trim()
    .toLowerCase();
}

function getMealUserIdAndDate(row) {
  const firstCell = String(row[0] || "").trim();
  const secondCell = String(row[1] || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(firstCell)) {
    return {
      userId: DEFAULT_USER_ID,
      date: firstCell,
    };
  }

  return {
    userId: normalizeUserId(firstCell),
    date: secondCell,
  };
}

async function main() {
  console.log(
    "WEEKLY BACKFILL START",
    JSON.stringify({ userId: BACKFILL_USER_ID }),
  );

  const rows = await getAllMeals();
  const uniqueDates = new Set();

  for (const row of rows) {
    const { userId, date } = getMealUserIdAndDate(row);

    if (userId !== BACKFILL_USER_ID) {
      continue;
    }

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

    await upsertWeeklyStatsRow({
      user_id: BACKFILL_USER_ID,
      week_start: context.week_start,
      week_end: context.week_end,
      intake: context.summary.intake,
      activity: context.summary.activity,
      net: context.summary.net,
      target: context.summary.target,
      remaining: context.summary.remaining,
      protein: context.summary.protein,
      carbs: context.summary.carbs,
      fat: context.summary.fat,
      recent_meals_json: JSON.stringify(context.recent_meals || []),
      food_frequency_json: JSON.stringify(context.food_frequency || {}),
      variety_warnings_json: JSON.stringify(context.variety_warnings || []),
      generated_at: new Date().toISOString(),
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
