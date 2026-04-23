const {} = require("../../config");

async function handleGetDietToday({ date }) {
  const report = await getTodayDietReport(date);
  return jsonResponse(200, report);
}

module.exports = {
  handleGetDietToday,
};
