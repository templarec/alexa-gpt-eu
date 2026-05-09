const {
  parseSheetNumber,
  roundNumber,
  getLastNDatesInclusive,
  getDiffDays,
} = require("./numbers-and-dates");
const { calculateBmrMifflin, calculateBmrKatch } = require("./body-formulas");
const { buildNormalizedActivityEntries } = require("./activity-normalizer");

const KCAL_PER_KG = 7700;
const ADAPTIVE_WINDOW_DAYS = 14;
const MIN_ADAPTIVE_DAYS_COVERED = 7;
const ROLLING_WEIGHT_WINDOW_DAYS = 7;
const MIN_DAILY_INTAKE_FOR_ADAPTIVE = 1000;
const MAX_WEIGHT_CHANGE_24H_RATIO = 0.01;
const MAX_WEIGHT_CHANGE_48H_RATIO = 0.0125;
const MAX_FILTERED_ADAPTIVE_MULTIPLIER = 1.2;
const MANUAL_REVIEW_ADAPTIVE_MULTIPLIER = 1.25;

function calculateRollingAverage(
  values,
  windowSize = ROLLING_WEIGHT_WINDOW_DAYS,
) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = values.slice(start, index + 1).filter((value) => {
      return Number.isFinite(value) && value > 0;
    });

    if (slice.length === 0) {
      return null;
    }

    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

function isDailyWeightChangeSuspicious(
  previousWeight,
  currentWeight,
  daysDiff,
) {
  if (!previousWeight || !currentWeight || !daysDiff) {
    return false;
  }

  const changeRatio = Math.abs(currentWeight - previousWeight) / previousWeight;

  if (daysDiff <= 1) {
    return changeRatio > MAX_WEIGHT_CHANGE_24H_RATIO;
  }

  if (daysDiff <= 2) {
    return changeRatio > MAX_WEIGHT_CHANGE_48H_RATIO;
  }

  return false;
}

function buildFilteredWeightSeries(dailyWeights) {
  const sortedEntries = [...dailyWeights.entries()]
    .map(([date, weight]) => ({ date, weight: Number(weight) }))
    .filter(
      (entry) =>
        entry.date && Number.isFinite(entry.weight) && entry.weight > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sortedEntries.length < 2) {
    return [];
  }

  const filteredEntries = [];

  for (const entry of sortedEntries) {
    const previousEntry = filteredEntries[filteredEntries.length - 1];

    if (previousEntry) {
      const daysDiff = getDiffDays(previousEntry.date, entry.date);

      if (
        isDailyWeightChangeSuspicious(
          previousEntry.weight,
          entry.weight,
          daysDiff,
        )
      ) {
        continue;
      }
    }

    filteredEntries.push(entry);
  }

  const rollingWeights = calculateRollingAverage(
    filteredEntries.map((entry) => entry.weight),
    ROLLING_WEIGHT_WINDOW_DAYS,
  );

  return filteredEntries
    .map((entry, index) => ({
      ...entry,
      smoothedWeight: rollingWeights[index],
    }))
    .filter((entry) => Number.isFinite(entry.smoothedWeight));
}

function filterMealRowsForAdaptive(mealRows) {
  const intakeByDate = new Map();

  for (const row of mealRows) {
    const date = String(row[0] || "").trim();
    const calories = parseSheetNumber(row[4]);

    if (!date) {
      continue;
    }

    intakeByDate.set(date, (intakeByDate.get(date) || 0) + calories);
  }

  const validDates = new Set();

  for (const [date, intake] of intakeByDate.entries()) {
    if (intake >= MIN_DAILY_INTAKE_FOR_ADAPTIVE) {
      validDates.add(date);
    }
  }

  return mealRows.filter((row) => {
    const date = String(row[0] || "").trim();
    return validDates.has(date);
  });
}

function capAdaptiveTdee(adaptiveTdeeRaw, formulaTdee) {
  if (!Number.isFinite(adaptiveTdeeRaw) || !Number.isFinite(formulaTdee)) {
    return {
      adaptiveTdeeFiltered: null,
      adaptiveTdeeCapped: false,
      adaptiveTdeeSuspicious: false,
    };
  }

  const cap = formulaTdee * MAX_FILTERED_ADAPTIVE_MULTIPLIER;
  const adaptiveTdeeFiltered = Math.min(adaptiveTdeeRaw, cap);

  return {
    adaptiveTdeeFiltered: roundNumber(adaptiveTdeeFiltered, 0),
    adaptiveTdeeCapped: adaptiveTdeeRaw > cap,
    adaptiveTdeeSuspicious:
      adaptiveTdeeRaw > formulaTdee * MANUAL_REVIEW_ADAPTIVE_MULTIPLIER,
  };
}

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
  const last14Dates = getLastNDatesInclusive(
    endDateString,
    ADAPTIVE_WINDOW_DAYS,
    {
      includeEndDate: false,
    },
  );

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

  const rawMealRows = (mealsResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  const mealRows = filterMealRowsForAdaptive(rawMealRows);

  const activityRows = (activityResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  const bodyRows = (bodyResponse.data.values || [])
    .slice(1)
    .filter((row) => dateSet.has(String(row[0] || "").trim()));

  if (mealRows.length === 0) {
    return null;
  }

  const coveredMealDates = new Set(
    mealRows.map((row) => String(row[0] || "").trim()).filter(Boolean),
  );

  if (coveredMealDates.size < MIN_ADAPTIVE_DAYS_COVERED) {
    return null;
  }

  const dailyWeights = new Map();

  for (const row of bodyRows) {
    const date = String(row[0] || "").trim();
    const weight = parseSheetNumber(row[3]);

    if (!date || !weight) {
      continue;
    }

    dailyWeights.set(date, weight);
  }

  const filteredWeightSeries = buildFilteredWeightSeries(dailyWeights);

  if (filteredWeightSeries.length < 2) {
    return null;
  }

  const firstWeightEntry = filteredWeightSeries[0];
  const lastWeightEntry = filteredWeightSeries[filteredWeightSeries.length - 1];

  const firstWeight = Number(firstWeightEntry.smoothedWeight);
  const lastWeight = Number(lastWeightEntry.smoothedWeight);
  const daysSpan = getDiffDays(firstWeightEntry.date, lastWeightEntry.date);

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

  if (!daysCovered || daysCovered < MIN_ADAPTIVE_DAYS_COVERED) {
    return null;
  }

  const averageDailyIntake = totalMealIntake / daysCovered;
  const impliedDailyDeficit =
    ((firstWeight - lastWeight) * KCAL_PER_KG) / daysSpan;
  const adaptiveTdeeRaw = averageDailyIntake + impliedDailyDeficit;

  if (
    !Number.isFinite(adaptiveTdeeRaw) ||
    adaptiveTdeeRaw < 1200 ||
    adaptiveTdeeRaw > 5000
  ) {
    return null;
  }

  return {
    adaptiveTdeeRaw: roundNumber(adaptiveTdeeRaw, 0),
    daysCovered,
    daysSpan,
    totalMealIntake: roundNumber(totalMealIntake, 0),
    totalActivity: roundNumber(totalActivity, 0),
    averageDailyIntake: roundNumber(averageDailyIntake, 0),
    impliedDailyDeficit: roundNumber(impliedDailyDeficit, 0),
    firstWeight: roundNumber(firstWeight, 2),
    lastWeight: roundNumber(lastWeight, 2),
    firstWeightDate: firstWeightEntry.date,
    lastWeightDate: lastWeightEntry.date,
    filteredWeightPoints: filteredWeightSeries.length,
  };
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
      adaptiveTdeeRaw: null,
      adaptiveTdeeFiltered: null,
      adaptiveTdeeCapped: false,
      adaptiveTdeeSuspicious: false,
      finalTdee: formulaTdee,
    };
  }

  const adaptiveTdeeResult = await getAdaptiveTdeeLast14Days(
    sheets,
    spreadsheetId,
    todayDate,
  );

  if (!adaptiveTdeeResult) {
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
        adaptiveTdeeRaw: null,
        adaptiveTdeeFiltered: null,
        adaptiveTdeeCapped: false,
        adaptiveTdeeSuspicious: false,
        finalTdee: formulaTdee,
        model: "formula_only",
      }),
    );

    return {
      formulaTdee,
      adaptiveTdee: null,
      adaptiveTdeeRaw: null,
      adaptiveTdeeFiltered: null,
      adaptiveTdeeCapped: false,
      adaptiveTdeeSuspicious: false,
      finalTdee: formulaTdee,
    };
  }

  const adaptiveTdeeRaw = adaptiveTdeeResult.adaptiveTdeeRaw;
  const { adaptiveTdeeFiltered, adaptiveTdeeCapped, adaptiveTdeeSuspicious } =
    capAdaptiveTdee(adaptiveTdeeRaw, formulaTdee);

  if (!adaptiveTdeeFiltered) {
    return {
      formulaTdee,
      adaptiveTdee: null,
      adaptiveTdeeRaw,
      adaptiveTdeeFiltered: null,
      adaptiveTdeeCapped,
      adaptiveTdeeSuspicious,
      finalTdee: formulaTdee,
    };
  }

  const finalTdee = roundNumber((formulaTdee + adaptiveTdeeFiltered) / 2, 0);

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
      adaptiveTdee: adaptiveTdeeFiltered,
      adaptiveTdeeRaw,
      adaptiveTdeeFiltered,
      adaptiveTdeeCapped,
      adaptiveTdeeSuspicious,
      adaptiveTdeeDetails: adaptiveTdeeResult,
      finalTdee,
      model: adaptiveTdeeCapped
        ? "blended_filtered_capped"
        : "blended_filtered",
    }),
  );

  return {
    formulaTdee,
    adaptiveTdee: adaptiveTdeeFiltered,
    adaptiveTdeeRaw,
    adaptiveTdeeFiltered,
    adaptiveTdeeCapped,
    adaptiveTdeeSuspicious,
    finalTdee,
  };
}

module.exports = {
  getAverageWeightLast7Days,
  getAverageBodyFatLast7Days,
  getAdaptiveTdeeLast14Days,
  getDynamicTdee,
};
