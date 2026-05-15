require("dotenv").config();
const { getAllMeals, getTodayDietReport } = require("./sheets");

const DEFAULT_USER_ID = "lorenzo";
const BACKFILL_USER_ID = String(process.env.BACKFILL_USER_ID || DEFAULT_USER_ID)
  .trim()
  .toLowerCase();
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

async function processDateWithRetry(date, userId) {
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_DATE; attempt++) {
    try {
      console.log(
        "PROCESSING",
        JSON.stringify({
          userId,
          date,
          attempt,
          maxRetries: MAX_RETRIES_PER_DATE,
        }),
      );

      await getTodayDietReport(date, null, { userId });

      console.log("DONE", JSON.stringify({ userId, date }));
      return;
    } catch (err) {
      if (isQuotaError(err) && attempt < MAX_RETRIES_PER_DATE) {
        console.warn(
          "QUOTA RETRY",
          JSON.stringify({
            userId,
            date,
            attempt,
            maxRetries: MAX_RETRIES_PER_DATE,
            waitMs: QUOTA_RETRY_DELAY_MS,
          }),
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
    const { userId, date } = getMealUserIdAndDate(row);

    if (userId !== BACKFILL_USER_ID) {
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dates.add(date);
    }
  }

  const sortedDates = [...dates].sort();

  console.log("BACKFILL USER ID", BACKFILL_USER_ID);
  console.log("DATES FOUND", sortedDates.length);
  console.log("RATE LIMIT DELAY MS", RATE_LIMIT_DELAY_MS);
  console.log("QUOTA RETRY DELAY MS", QUOTA_RETRY_DELAY_MS);
  console.log("MAX RETRIES PER DATE", MAX_RETRIES_PER_DATE);

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];

    try {
      await processDateWithRetry(date, BACKFILL_USER_ID);
    } catch (err) {
      console.error(
        "ERROR",
        JSON.stringify({
          userId: BACKFILL_USER_ID,
          date,
          message: err.message,
        }),
      );
    }

    if (i < sortedDates.length - 1) {
      console.log("WAITING BEFORE NEXT DATE", `${RATE_LIMIT_DELAY_MS}ms`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(
    "BACKFILL COMPLETE",
    JSON.stringify({
      userId: BACKFILL_USER_ID,
      count: sortedDates.length,
    }),
  );
}

backfillDailyStats();
