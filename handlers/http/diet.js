const { getTodayDietReport } = require("../../sheets");
const { jsonResponse } = require("../../utils/http");

async function handleGetDietToday({ date }) {
  const report = await getTodayDietReport(date);
  return jsonResponse(200, report);
}

module.exports = {
  handleGetDietToday,
};
