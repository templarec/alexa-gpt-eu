

const { DAILY_TARGET } = require("../../config");
const { getTodayDietReport } = require("../../sheets");
const { jsonResponse } = require("../../utils/http");

async function handleGetDietToday({ date }) {
  const report = await getTodayDietReport(date, DAILY_TARGET);
  return jsonResponse(200, report);
}

module.exports = {
  handleGetDietToday
};