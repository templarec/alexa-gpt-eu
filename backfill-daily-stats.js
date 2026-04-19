require("dotenv").config();
const { getAllMeals, getTodayDietReport } = require("./sheets");

const RATE_LIMIT_DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 20000);
const QUOTA_RETRY_DELAY_MS = Number(
  process.env.BACKFILL_QUOTA_RETRY_DELAY_MS || 60000,
);
const MAX_RETRIES_PER_DATE = Number(process.env.BACKFILL_MAX_RETRIES || 3);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("quota exceeded") ||
    message.includes("read requests per minute per user")
  );
}

async function processDateWithRetry(date) {
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_DATE; attempt++) {
    try {
      console.log(
        "PROCESSING",
        date,
        `attempt ${attempt}/${MAX_RETRIES_PER_DATE}`,
      );

      await getTodayDietReport(date);

      console.log("DONE", date);
      return;
    } catch (err) {
      if (isQuotaError(err) && attempt < MAX_RETRIES_PER_DATE) {
        console.warn(
          "QUOTA RETRY",
          date,
          `attempt ${attempt}/${MAX_RETRIES_PER_DATE}`,
          `waiting ${QUOTA_RETRY_DELAY_MS}ms`,
        );
        await sleep(QUOTA_RETRY_DELAY_MS);
        continue;
      }

      throw err;
    }
  }
}

async function backfillDailyStats() {
  const rows = await getAllMeals();

  if (!rows || rows.length <= 1) {
    console.log("No meals found");
    return;
  }

  const dates = new Set();

  for (const row of rows.slice(1)) {
    const date = String(row[0] || "").trim();
    if (date) dates.add(date);
  }

  const sortedDates = [...dates].sort();

  console.log("DATES FOUND", sortedDates.length);
  console.log("RATE LIMIT DELAY MS", RATE_LIMIT_DELAY_MS);
  console.log("QUOTA RETRY DELAY MS", QUOTA_RETRY_DELAY_MS);
  console.log("MAX RETRIES PER DATE", MAX_RETRIES_PER_DATE);

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];

    try {
      await processDateWithRetry(date);
    } catch (err) {
      console.error("ERROR", date, err.message);
    }

    if (i < sortedDates.length - 1) {
      console.log("WAITING BEFORE NEXT DATE", `${RATE_LIMIT_DELAY_MS}ms`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log("BACKFILL COMPLETE");
}

backfillDailyStats();
