const {
  getAllMeals,
  getWeekDietContext,
  upsertWeeklyStatsRow,
} = require("./sheets");

function getMonday(dateString) {
  const date = new Date(dateString + "T00:00:00");
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const rows = await getAllMeals();

  console.log("ROWS TOTAL:", rows.length);
  console.log("FIRST 5 ROWS:", JSON.stringify(rows.slice(0, 5), null, 2));

  const dates = rows
    .slice(1)
    .map((row) => String(row[0] || "").trim())
    .filter(Boolean);

  console.log("DATES FOUND:", dates.length);
  console.log("FIRST 10 DATES:", dates.slice(0, 10));

  const weeks = [...new Set(dates.map(getMonday))].sort();

  console.log("WEEKS FOUND:", weeks.length);
  console.log("WEEKS:", weeks);

  if (weeks.length === 0) return;

  const context = await getWeekDietContext(weeks[0]);

  console.log(
    "FIRST CONTEXT:",
    JSON.stringify(
      {
        week_start: context.week_start,
        week_end: context.week_end,
        summary: context.summary,
      },
      null,
      2,
    ),
  );

  const result = await upsertWeeklyStatsRow({
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
    source: "debug",
  });

  console.log("UPSERT RESULT:", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
