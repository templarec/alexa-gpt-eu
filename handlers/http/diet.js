const { getTodayDietReport } = require("../../services/dietReport");
const { getWeekDietContext } = require("../../services/weekContext");
const { jsonResponse } = require("../../utils/http");

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

function normalizeUserId(userId) {
  return (
    String(userId || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
}

async function handleGetDietToday({ date, userId = DEFAULT_USER_ID }) {
  const normalizedUserId = normalizeUserId(userId);

  const report = await getTodayDietReport(date, null, {
    userId: normalizedUserId,
  });

  let weekContext = null;

  try {
    weekContext = await getWeekDietContext(date, {
      userId: normalizedUserId,
    });
  } catch (error) {
    console.error(
      "DIET TODAY WEEK CONTEXT FAILED",
      JSON.stringify({
        userId: normalizedUserId,
        date,
        message: String(error?.message || error),
      }),
    );
  }

  return jsonResponse(200, {
    ...report,
    week_context: weekContext,
  });
}

module.exports = {
  handleGetDietToday,
};
