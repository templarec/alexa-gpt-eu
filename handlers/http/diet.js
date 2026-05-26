const { getTodayDietReport } = require("../../services/dietReport");
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

  return jsonResponse(200, report);
}

module.exports = {
  handleGetDietToday,
};
