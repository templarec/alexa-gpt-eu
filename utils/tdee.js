const {
  parseSheetNumber,
  roundNumber,
  getLastNDatesInclusive,
  getDiffDays,
} = require("./numbers-and-dates");
const { calculateBmrMifflin, calculateBmrKatch } = require("./body-formulas");
const { buildNormalizedActivityEntries } = require("./activity-normalizer");

const KCAL_PER_KG = 7700;

async function getAverageWeightLast7Days(
  sheets,
  spreadsheetId,
  todayDate = null,
) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Body!A:J",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    return null;
  }

  const endDateString = todayDate || new Date().toISOString().slice(0, 10);
  const last7Dates = getLastNDatesInclusive(endDateString, 7);
  const allowedDates = new Set(last7Dates);

  if (allowedDates.size === 0) {
    return null;
  }

  const dailyWeights = new Map();

  for (const row of rows.slice(1)) {
    const date = String(row[0] || "").trim();
    const weight = parseSheetNumber(row[3]);

    if (!date || !weight || !allowedDates.has(date)) {
      continue;
    }

    dailyWeights.set(date, weight);
  }

  const weights = [...dailyWeights.values()].filter(
    (value) => Number.isFinite(value) && value > 0,
  );

  if (weights.length === 0) {
    return null;
  }

  const average =
    weights.reduce((sum, value) => sum + value, 0) / weights.length;

  return roundNumber(average, 2);
}

async function getAverageBodyFatLast7Days(
  sheets,
  spreadsheetId,
  todayDate = null,
) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Body!A:J",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    return null;
  }

  const endDateString = todayDate || new Date().toISOString().slice(0, 10);
  const last7Dates = getLastNDatesInclusive(endDateString, 7);
  const allowedDates = new Set(last7Dates);

  if (allowedDates.size === 0) {
    return null;
  }

  const dailyBodyFat = new Map();

  for (const row of rows.slice(1)) {
    const date = String(row[0] || "").trim();
    const bodyFat = parseSheetNumber(row[4]);

    if (!date || !bodyFat || !allowedDates.has(date)) {
      continue;
    }

    dailyBodyFat.set(date, bodyFat);
  }

  const bodyFatValues = [...dailyBodyFat.values()].filter(
    (value) => Number.isFinite(value) && value > 0,
  );

  if (bodyFatValues.length === 0) {
    return null;
  }

  const average =
    bodyFatValues.reduce((sum, value) => sum + value, 0) / bodyFatValues.length;

  return roundNumber(average, 2);
}

async function getAdaptiveTdeeLast14Days(sheets, spreadsheetId, endDateString) {
  const last14Dates = getLastNDatesInclusive(endDateString, 14, {
    includeEndDate: false,
  });

  if (last14Dates.length === 0) {
    return null;
  }

  const dateSet = new Set(last14Dates);

  const [mealsResponse, activityResponse, bodyResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Meals!A:H",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "activity!A:M",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Body!A:J",
    }),
  ]);

  const mealRows = (mealsResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  const activityRows = (activityResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  const bodyRows = (bodyResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  const dailyWeights = new Map();

  for (const row of bodyRows) {
    const date = String(row[0] || "").trim();
    const weight = parseSheetNumber(row[3]);

    if (!date || !weight) {
      continue;
    }

    dailyWeights.set(date, weight);
  }

  const weightDates = [...dailyWeights.keys()].sort();

  if (weightDates.length < 2) {
    return null;
  }

  if (mealRows.length === 0) {
    return null;
  }

  const coveredMealDates = new Set(
    mealRows.map((row) => String(row[0] || "").trim()).filter(Boolean),
  );

  if (coveredMealDates.size < 7) {
    return null;
  }

  const firstWeightDate = weightDates[0];
  const lastWeightDate = weightDates[weightDates.length - 1];

  const firstWeight = Number(dailyWeights.get(firstWeightDate));
  const lastWeight = Number(dailyWeights.get(lastWeightDate));
  const daysSpan = getDiffDays(firstWeightDate, lastWeightDate);

  if (!firstWeight || !lastWeight || daysSpan < 3) {
    return null;
  }

  const totalMealIntake = mealRows.reduce(
    (sum, row) => sum + parseSheetNumber(row[4]),
    0,
  );

  const normalizedActivities = buildNormalizedActivityEntries(activityRows);

  const totalActivity = normalizedActivities.reduce(
    (sum, entry) => sum + Number(entry.calories || 0),
    0,
  );

  const daysCovered = coveredMealDates.size;

  if (!daysCovered || daysCovered < 7) {
    return null;
  }

  const averageDailyNet = (totalMealIntake + totalActivity) / daysCovered;
  const impliedDailyDeficit =
    ((firstWeight - lastWeight) * KCAL_PER_KG) / daysSpan;
  const adaptiveTdee = averageDailyNet + impliedDailyDeficit;

  if (
    !Number.isFinite(adaptiveTdee) ||
    adaptiveTdee < 1200 ||
    adaptiveTdee > 5000
  ) {
    return null;
  }

  return roundNumber(adaptiveTdee, 0);
}

async function getDynamicTdee({
  sheets,
  spreadsheetId,
  getConfigValue,
  todayActivityKcal = 0,
  todayDate = null,
  fallbackWeightKg = 95,
  fallbackSex = "male",
  fallbackAge = 31,
  fallbackHeightCm = 181,
  fallbackBaseActivityFactor = 1.2,
}) {
  const averageWeightLast7Days = await getAverageWeightLast7Days(
    sheets,
    spreadsheetId,
    todayDate,
  );

  const sex = (await getConfigValue("user_sex")) || fallbackSex;
  const age = Number(await getConfigValue("user_age")) || fallbackAge;
  const heightCm =
    Number(await getConfigValue("user_height_cm")) || fallbackHeightCm;
  const baseActivityFactor =
    Number(await getConfigValue("base_activity_factor")) ||
    fallbackBaseActivityFactor;

  const weightKg = Number(averageWeightLast7Days || fallbackWeightKg);

  const bmrMifflin = calculateBmrMifflin({
    weightKg,
    heightCm,
    age,
    sex,
  });

  const bodyFatPercent = await getAverageBodyFatLast7Days(
    sheets,
    spreadsheetId,
    todayDate,
  );

  const bmrKatch = calculateBmrKatch({
    weightKg,
    bodyFatPercent,
  });

  let bmr = null;

  if (bmrMifflin && bmrKatch) {
    bmr = (bmrMifflin + bmrKatch) / 2;
  } else {
    bmr = bmrMifflin || bmrKatch;
  }

  if (!bmr) {
    return null;
  }

  const baseTdee = bmr * baseActivityFactor;
  const extraActivity = Math.abs(Number(todayActivityKcal || 0));
  const formulaTdee = roundNumber(baseTdee + extraActivity, 0);

  if (!todayDate) {
    return {
      formulaTdee,
      adaptiveTdee: null,
      finalTdee: formulaTdee,
    };
  }

  const adaptiveTdee = await getAdaptiveTdeeLast14Days(
    sheets,
    spreadsheetId,
    todayDate,
  );

  if (!adaptiveTdee) {
    console.log(
      "TDEE CALCULATION",
      JSON.stringify({
        todayDate,
        weightKg,
        bodyFatPercent,
        bmrMifflin: roundNumber(bmrMifflin, 0),
        bmrKatch: bmrKatch ? roundNumber(bmrKatch, 0) : null,
        bmr: roundNumber(bmr, 0),
        baseActivityFactor,
        extraActivity,
        formulaTdee,
        adaptiveTdee: null,
        finalTdee: formulaTdee,
        model: "formula_only",
      }),
    );

    return {
      formulaTdee,
      adaptiveTdee: null,
      finalTdee: formulaTdee,
    };
  }

  const finalTdee = roundNumber((formulaTdee + adaptiveTdee) / 2, 0);

  console.log(
    "TDEE CALCULATION",
    JSON.stringify({
      todayDate,
      weightKg,
      bodyFatPercent,
      bmrMifflin: roundNumber(bmrMifflin, 0),
      bmrKatch: bmrKatch ? roundNumber(bmrKatch, 0) : null,
      bmr: roundNumber(bmr, 0),
      baseActivityFactor,
      extraActivity,
      formulaTdee,
      adaptiveTdee,
      finalTdee,
      model: "blended",
    }),
  );

  return {
    formulaTdee,
    adaptiveTdee,
    finalTdee,
  };
}

module.exports = {
  getAverageWeightLast7Days,
  getAverageBodyFatLast7Days,
  getAdaptiveTdeeLast14Days,
  getDynamicTdee,
};
