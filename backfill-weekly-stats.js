const {
  getAllMeals,
  getWeekDietContext,
  upsertWeeklyStatsRow,
} = require("./sheets");

function getMonday(dateString) {
  const date = new Date(dateString + "T00:00:00");
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // domenica -> lunedì precedente
  date.setDate(date.getDate() + diff);

  return date.toISOString().slice(0, 10);
}

async function main() {
  console.log("WEEKLY BACKFILL START");

  const rows = await getAllMeals();

  const uniqueDates = new Set();

  for (const row of rows) {
    const date = String(row[0] || "").trim();
    if (date) uniqueDates.add(date);
  }

  const uniqueWeeks = new Set();

  for (const date of uniqueDates) {
    uniqueWeeks.add(getMonday(date));
  }

  const sortedWeeks = [...uniqueWeeks].sort();

  console.log("WEEKS FOUND:", sortedWeeks.length);

  for (const weekStart of sortedWeeks) {
    console.log("PROCESSING WEEK:", weekStart);

    const context = await getWeekDietContext(weekStart);

    await upsertWeeklyStatsRow({
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

  console.log("WEEKLY BACKFILL DONE");
}

main().catch((err) => {
  console.error("WEEKLY BACKFILL FAILED", err);
  process.exit(1);
});
