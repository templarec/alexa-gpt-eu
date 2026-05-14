const { getTodayDietReport } = require("../../sheets");
const { jsonResponse } = require("../../utils/http");

async function handleGetDietToday({ date, userId = "lorenzo" }) {
  const report = await getTodayDietReport(date, null, { userId });
  return jsonResponse(200, report);
}

module.exports = {
  handleGetDietToday,
};
