const { google } = require("googleapis");

let sheetsClientPromise = null;

const CACHE_TTL_MS = 60 * 1000;

const cache = {
  activitySourceIds: {
    value: null,
    expiresAt: 0,
  },
  lastBodyRow: {
    value: null,
    expiresAt: 0,
  },
  todayMeals: {
    value: null,
    expiresAt: 0,
  },
  todayActivities: {
    value: null,
    expiresAt: 0,
  },
};

function isCacheValid(entry) {
  return entry.value != null && Date.now() < entry.expiresAt;
}

function setCache(entry, value) {
  entry.value = value;
  entry.expiresAt = Date.now() + CACHE_TTL_MS;
}

function parseSheetNumber(value) {
  if (value == null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value).trim().replace(/\./g, "").replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundNumber(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function calculateBmrMifflin({ weightKg, heightCm, age, sex }) {
  const weight = Number(weightKg || 0);
  const height = Number(heightCm || 0);
  const ageNum = Number(age || 0);
  const normalizedSex = String(sex || "")
    .trim()
    .toLowerCase();

  if (!weight || !height || !ageNum) {
    return null;
  }

  if (normalizedSex === "female" || normalizedSex === "f") {
    return 10 * weight + 6.25 * height - 5 * ageNum - 161;
  }

  return 10 * weight + 6.25 * height - 5 * ageNum + 5;
}

function calculateBmrKatch({ weightKg, bodyFatPercent }) {
  const weight = Number(weightKg || 0);
  const bf = Number(bodyFatPercent || 0);

  if (!weight || !bf) {
    return null;
  }

  const bodyFatRatio = bf / 100;
  const leanMass = weight * (1 - bodyFatRatio);

  if (!leanMass || !Number.isFinite(leanMass)) {
    return null;
  }

  return 370 + 21.6 * leanMass;
}

const AVG_STEP_LENGTH_M = 0.6;
const WALKING_KCAL_PER_KM = 71;
const RESIDUAL_STEPS_KCAL_PER_KM = 55;
const DEFAULT_BIKE_CADENCE_RPM = 60;

const KCAL_PER_KG = 7700;

function parseIsoDate(dateString) {
  const value = String(dateString || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getLastNDatesInclusive(endDateString, daysCount, options = {}) {
  const endDate = parseIsoDate(endDateString);

  if (!endDate || !daysCount || daysCount < 1) {
    return [];
  }

  const includeEndDate = options.includeEndDate !== false;
  const effectiveEndDate = new Date(endDate);

  if (!includeEndDate) {
    effectiveEndDate.setUTCDate(effectiveEndDate.getUTCDate() - 1);
  }

  const dates = [];

  for (let i = daysCount - 1; i >= 0; i--) {
    const current = new Date(effectiveEndDate);
    current.setUTCDate(current.getUTCDate() - i);
    dates.push(formatIsoDate(current));
  }

  return dates;
}

function getDiffDays(startDateString, endDateString) {
  const start = parseIsoDate(startDateString);
  const end = parseIsoDate(endDateString);

  if (!start || !end) {
    return 0;
  }

  const diffMs = end.getTime() - start.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function getGoogleCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON non configurata");
  }

  return JSON.parse(raw);
}

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = getGoogleCredentials();

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      return google.sheets({
        version: "v4",
        auth,
      });
    })();
  }

  return sheetsClientPromise;
}

async function appendMealRow(row) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:H",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  const mealDate = row[0] || "";

  if (
    isCacheValid(cache.todayMeals) &&
    cache.todayMeals.value?.date === mealDate
  ) {
    setCache(cache.todayMeals, {
      date: mealDate,
      rows: [...cache.todayMeals.value.rows, row],
    });
  }
}

async function appendBodyRow(row) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "Body!A:J",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  let sourceDate = null;
  try {
    const rawGroup = JSON.parse(row[9] || "{}");
    sourceDate = rawGroup.date ?? null;
  } catch (error) {
    sourceDate = null;
  }

  const cachedBody = {
    date: row[0] || "",
    time: row[1] || "",
    source: row[2] || "",
    weight: Number(row[3] || 0),
    bodyFat: row[4] === "" || row[4] == null ? null : Number(row[4]),
    muscleMass: row[5] === "" || row[5] == null ? null : Number(row[5]),
    waterMass: row[6] === "" || row[6] == null ? null : Number(row[6]),
    fatMass: row[7] === "" || row[7] == null ? null : Number(row[7]),
    leanMass: row[8] === "" || row[8] == null ? null : Number(row[8]),
    rawJson: row[9] || "",
    sourceDate,
  };

  setCache(cache.lastBodyRow, cachedBody);

  console.log(
    "SHEET BODY ROW WRITTEN",
    JSON.stringify({
      date: cachedBody.date,
      time: cachedBody.time,
      source: cachedBody.source,
      weight: cachedBody.weight,
    }),
  );
}

async function appendActivityRow(row) {
  const sheets = await getSheetsClient();
  const sourceId = row[10];
  const date = row[0] || "";
  const source = row[2] || "";

  if (sourceId && (await hasActivitySourceId(sourceId))) {
    if (String(sourceId).startsWith("withings-steps-")) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: "activity!A:M",
      });

      const rows = res.data.values || [];
      const existingIndex = rows.findIndex(
        (r, idx) => idx > 0 && r[10] === String(sourceId),
      );

      if (existingIndex !== -1) {
        const sheetRowNumber = existingIndex + 1;

        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SHEET_ID,
          range: `activity!A${sheetRowNumber}:M${sheetRowNumber}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [row],
          },
        });

        if (
          isCacheValid(cache.todayActivities) &&
          cache.todayActivities.value?.date === date
        ) {
          const currentRows = [...(cache.todayActivities.value.rows || [])];
          const cachedIndex = currentRows.findIndex(
            (r) => r[10] === String(sourceId),
          );

          if (cachedIndex !== -1) {
            currentRows[cachedIndex] = row;
          } else {
            currentRows.push(row);
          }

          setCache(cache.todayActivities, {
            date,
            rows: currentRows,
          });
        }

        console.log(
          "SHEET ACTIVITY UPDATED",
          JSON.stringify({
            sourceId: String(sourceId),
            date,
            source,
          }),
        );

        return {
          success: true,
          updated: true,
          sourceId: String(sourceId),
          rowNumber: sheetRowNumber,
        };
      }
    }

    console.log(
      "SHEET ACTIVITY SKIPPED DUPLICATE",
      JSON.stringify({
        sourceId: String(sourceId),
      }),
    );

    return {
      success: true,
      skipped: true,
      reason: "duplicate_source_id",
      sourceId: String(sourceId),
    };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!A:M",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  console.log(
    "SHEET ACTIVITY ROW WRITTEN",
    JSON.stringify({
      sourceId: sourceId ? String(sourceId) : null,
      date,
      source,
    }),
  );

  if (sourceId) {
    const currentIds = isCacheValid(cache.activitySourceIds)
      ? cache.activitySourceIds.value
      : [];

    if (!currentIds.includes(String(sourceId))) {
      setCache(cache.activitySourceIds, [...currentIds, String(sourceId)]);
    }
  }

  if (
    isCacheValid(cache.todayActivities) &&
    cache.todayActivities.value?.date === date
  ) {
    setCache(cache.todayActivities, {
      date,
      rows: [...cache.todayActivities.value.rows, row],
    });
  }

  return {
    success: true,
    skipped: false,
    sourceId: sourceId ? String(sourceId) : null,
  };
}

async function hasActivitySourceId(sourceId) {
  if (!sourceId) {
    return false;
  }

  if (isCacheValid(cache.activitySourceIds)) {
    return cache.activitySourceIds.value.includes(String(sourceId));
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!K:K",
  });

  const sourceIds = (response.data.values || [])
    .flat()
    .slice(1)
    .filter(Boolean)
    .map(String);

  setCache(cache.activitySourceIds, sourceIds);

  return sourceIds.includes(String(sourceId));
}

async function getLastBodyRow() {
  if (isCacheValid(cache.lastBodyRow)) {
    return cache.lastBodyRow.value;
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Body!A:J",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.lastBodyRow, null);
    return null;
  }

  const last = rows[rows.length - 1];
  let sourceDate = null;

  try {
    const rawGroup = JSON.parse(last[9] || "{}");
    sourceDate = rawGroup.date ?? null;
  } catch (error) {
    sourceDate = null;
  }

  const result = {
    date: last[0] || "",
    time: last[1] || "",
    source: last[2] || "",
    weight: Number(last[3] || 0),
    bodyFat: last[4] === "" || last[4] == null ? null : Number(last[4]),
    muscleMass: last[5] === "" || last[5] == null ? null : Number(last[5]),
    waterMass: last[6] === "" || last[6] == null ? null : Number(last[6]),
    fatMass: last[7] === "" || last[7] == null ? null : Number(last[7]),
    leanMass: last[8] === "" || last[8] == null ? null : Number(last[8]),
    rawJson: last[9] || "",
    sourceDate,
  };

  setCache(cache.lastBodyRow, result);

  return result;
}

async function getLatestWeight() {
  const last = await getLastBodyRow();

  if (!last || !last.weight) {
    return null;
  }

  return Number(last.weight);
}

async function getAverageWeightLast7Days(todayDate = null) {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
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

async function getAverageBodyFatLast7Days(todayDate = null) {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
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

async function getDynamicTdee(todayActivityKcal = 0, todayDate = null) {
  const averageWeightLast7Days = await getAverageWeightLast7Days(todayDate);

  const sex =
    (await getConfigValue("user_sex")) || process.env.USER_SEX || "male";
  const age =
    Number(await getConfigValue("user_age")) ||
    Number(process.env.USER_AGE) ||
    31;
  const heightCm =
    Number(await getConfigValue("user_height_cm")) ||
    Number(process.env.USER_HEIGHT_CM) ||
    181;
  const baseActivityFactor =
    Number(await getConfigValue("base_activity_factor")) ||
    Number(process.env.BASE_ACTIVITY_FACTOR) ||
    1.2;

  const fallbackWeight = Number(process.env.USER_WEIGHT_KG || 95);
  const weightKg = Number(averageWeightLast7Days || fallbackWeight);

  const bmrMifflin = calculateBmrMifflin({
    weightKg,
    heightCm,
    age,
    sex,
  });

  const bodyFatPercent = await getAverageBodyFatLast7Days(todayDate);

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

  const adaptiveTdee = await getAdaptiveTdeeLast14Days(todayDate);

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

function buildNormalizedActivityEntries(activityRows) {
  const normalizedActivities = activityRows.map((row) => ({
    date: row[0] || "",
    time: row[1] || "",
    source: String(row[2] || "")
      .trim()
      .toLowerCase(),
    activityType: String(row[3] || "")
      .trim()
      .toLowerCase(),
    description: row[4] || "",
    rawCalories: parseSheetNumber(row[5]),
    distanceKm: parseSheetNumber(row[6]),
    durationMin: parseSheetNumber(row[7]),
    steps: parseSheetNumber(row[8]),
  }));

  const withingsStepsEntry = normalizedActivities.find(
    (entry) => entry.source === "withings" && entry.activityType === "steps",
  );

  const komootWalkHikeActivities = normalizedActivities.filter(
    (entry) =>
      entry.source === "komoot" &&
      (entry.activityType === "hike" || entry.activityType === "walk"),
  );

  const komootBikeActivities = normalizedActivities.filter(
    (entry) => entry.source === "komoot" && entry.activityType === "bike",
  );

  const rawEstimatedKomootWalkHikeSteps = Math.round(
    komootWalkHikeActivities.reduce(
      (sum, entry) => sum + (entry.distanceKm * 1000) / AVG_STEP_LENGTH_M,
      0,
    ),
  );

  const rawEstimatedKomootBikeSteps = Math.round(
    komootBikeActivities.reduce(
      (sum, entry) => sum + entry.durationMin * DEFAULT_BIKE_CADENCE_RPM * 2,
      0,
    ),
  );

  const rawEstimatedKomootOverlapSteps =
    rawEstimatedKomootWalkHikeSteps + rawEstimatedKomootBikeSteps;

  const estimatedKomootOverlapSteps = withingsStepsEntry
    ? Math.min(withingsStepsEntry.steps, rawEstimatedKomootOverlapSteps)
    : rawEstimatedKomootOverlapSteps;

  let residualWithingsCalories = null;

  if (withingsStepsEntry) {
    const residualWithingsSteps = Math.max(
      0,
      withingsStepsEntry.steps - estimatedKomootOverlapSteps,
    );
    const residualWithingsKm =
      (residualWithingsSteps * AVG_STEP_LENGTH_M) / 1000;
    residualWithingsCalories = Math.round(
      residualWithingsKm * RESIDUAL_STEPS_KCAL_PER_KM,
    );

    console.log(
      "WITHINGS STEPS OVERLAP ADJUSTMENT",
      JSON.stringify({
        withingsSteps: withingsStepsEntry.steps,
        estimatedWalkHikeSteps: rawEstimatedKomootWalkHikeSteps,
        estimatedBikeSteps: rawEstimatedKomootBikeSteps,
        estimatedOverlapSteps: estimatedKomootOverlapSteps,
        residualWithingsSteps,
        residualWithingsCalories,
        bikeCadenceRpm: DEFAULT_BIKE_CADENCE_RPM,
      }),
    );
  }

  return normalizedActivities.map((entry) => {
    let rawCalories = entry.rawCalories;

    if (
      withingsStepsEntry &&
      entry.source === "withings" &&
      entry.activityType === "steps"
    ) {
      rawCalories =
        residualWithingsCalories == null
          ? rawCalories
          : residualWithingsCalories;
    }

    return {
      date: entry.date,
      time: entry.time,
      meal_type: "attivita",
      description: entry.description,
      calories: rawCalories > 0 ? -rawCalories : rawCalories,
      protein: 0,
      carbs: 0,
      fat: 0,
      running_total: 0,
    };
  });
}

async function getAdaptiveTdeeLast14Days(endDateString) {
  const sheets = await getSheetsClient();
  const last14Dates = getLastNDatesInclusive(endDateString, 14, {
    includeEndDate: false,
  });

  if (last14Dates.length === 0) {
    return null;
  }

  const dateSet = new Set(last14Dates);

  const [mealsResponse, activityResponse, bodyResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Meals!A:H",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "activity!A:M",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
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

  const averageDailyNet = (totalMealIntake + totalActivity) / 14;
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

async function getConfigValue(key) {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Config!A:B",
  });

  const rows = response.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    const rowKey = rows[i][0];
    const rowValue = rows[i][1];

    if (rowKey === key) {
      return rowValue || null;
    }
  }

  return null;
}

async function setConfigValue(key, value) {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Config!A:B",
  });

  const rows = response.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    const rowKey = rows[i][0];

    if (rowKey === key) {
      const rowNumber = i + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SHEET_ID,
        range: `Config!A${rowNumber}:B${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[key, value]],
        },
      });

      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "Config!A:B",
    valueInputOption: "RAW",
    requestBody: {
      values: [[key, value]],
    },
  });
}

async function upsertDailyStatsRow(row) {
  const sheets = await getSheetsClient();
  const date = String(row[0] || "").trim();

  if (!date) {
    throw new Error("DailyStats row missing date");
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "DailyStats!A:L",
  });

  const rows = response.data.values || [];
  const existingIndex = rows.findIndex(
    (existingRow, idx) =>
      idx > 0 && String(existingRow[0] || "").trim() === date,
  );

  if (existingIndex !== -1) {
    const rowNumber = existingIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `DailyStats!A${rowNumber}:L${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });

    console.log(
      "DAILY STATS ROW UPDATED",
      JSON.stringify({
        date,
        rowNumber,
        intake: row[1],
        activity: row[2],
        net: row[3],
        target: row[4],
        tdeeFinal: row[7],
        deficit: row[8],
      }),
    );

    return {
      success: true,
      updated: true,
      rowNumber,
    };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "DailyStats!A:L",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  console.log(
    "DAILY STATS ROW APPENDED",
    JSON.stringify({
      date,
      intake: row[1],
      activity: row[2],
      net: row[3],
      target: row[4],
      tdeeFinal: row[7],
      deficit: row[8],
    }),
  );

  return {
    success: true,
    updated: false,
  };
}

async function saveDailyStatsSnapshot({
  date,
  summary,
  weight,
  bodyFat,
  notes,
}) {
  const row = [
    date,
    summary?.intake ?? 0,
    Math.abs(Number(summary?.activity || 0)),
    summary?.net ?? 0,
    summary?.target ?? 0,
    summary?.tdee_formula ?? "",
    summary?.tdee_adaptive ?? "",
    summary?.tdee ?? "",
    summary?.deficit ?? 0,
    weight ?? "",
    bodyFat ?? "",
    notes || "",
  ];

  const result = await upsertDailyStatsRow(row);

  console.log(
    "DAILY STATS SNAPSHOT SAVED",
    JSON.stringify({
      date,
      updated: result?.updated ?? false,
      intake: row[1],
      activity: row[2],
      net: row[3],
      target: row[4],
      tdeeFinal: row[7],
      deficit: row[8],
      weight: row[9],
      bodyFat: row[10],
    }),
  );

  return result;
}

async function getTodayRows(todayDate) {
  if (
    isCacheValid(cache.todayMeals) &&
    cache.todayMeals.value?.date === todayDate
  ) {
    return cache.todayMeals.value.rows;
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:H",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.todayMeals, { date: todayDate, rows: [] });
    return [];
  }

  const filtered = rows
    .slice(1)
    .filter((row) => String(row[0] || "").trim() === todayDate);
  setCache(cache.todayMeals, { date: todayDate, rows: filtered });

  return filtered;
}

async function getTodayActivityRows(todayDate) {
  if (
    isCacheValid(cache.todayActivities) &&
    cache.todayActivities.value?.date === todayDate
  ) {
    return cache.todayActivities.value.rows;
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!A:M",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.todayActivities, { date: todayDate, rows: [] });
    return [];
  }

  const filtered = rows
    .slice(1)
    .filter((row) => String(row[0] || "").trim() === todayDate);
  setCache(cache.todayActivities, { date: todayDate, rows: filtered });

  return filtered;
}

async function getTodayRunningTotal(todayDate) {
  const rows = await getTodayRows(todayDate);

  return rows.reduce((sum, row) => sum + parseSheetNumber(row[4]), 0);
}

async function getTodaySummary(todayDate) {
  const rows = await getTodayRows(todayDate);

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;

  for (const row of rows) {
    calories += parseSheetNumber(row[4]);
    protein += parseSheetNumber(row[5]);
    carbs += parseSheetNumber(row[6]);
    fat += parseSheetNumber(row[7]);
  }

  return {
    calories,
    protein,
    carbs,
    fat,
    count: rows.length,
  };
}

async function getTodayDietReport(todayDate, targetCalories = 1750) {
  const rows = await getTodayRows(todayDate);
  const activityRows = await getTodayActivityRows(todayDate);

  let runningTotal = 0;

  const meals = rows.map((row) => {
    const calories = parseSheetNumber(row[4]);
    runningTotal += calories;

    return {
      date: row[0] || "",
      time: row[1] || "",
      meal_type: row[2] || "",
      description: row[3] || "",
      calories,
      protein: parseSheetNumber(row[5]),
      carbs: parseSheetNumber(row[6]),
      fat: parseSheetNumber(row[7]),
      running_total: runningTotal,
    };
  });

  const activities = buildNormalizedActivityEntries(activityRows);

  let intake = 0;
  let activity = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;

  for (const meal of meals) {
    intake += meal.calories;
    protein += meal.protein;
    carbs += meal.carbs;
    fat += meal.fat;
  }

  for (const entry of activities) {
    activity += entry.calories;
  }

  intake = roundNumber(intake, 0);
  activity = roundNumber(activity, 0);
  protein = roundNumber(protein, 1);
  carbs = roundNumber(carbs, 1);
  fat = roundNumber(fat, 1);

  const net = roundNumber(intake + activity, 0);
  const tdeeData = await getDynamicTdee(activity, todayDate);

  const resolvedTdee =
    tdeeData?.finalTdee ?? roundNumber(targetCalories + 650, 0);
  const remaining = roundNumber(targetCalories - net, 0);
  const deficit = roundNumber(resolvedTdee - net, 0);

  const summary = {
    intake,
    activity,
    net,
    protein,
    carbs,
    fat,
    target: targetCalories,

    tdee_formula: tdeeData?.formulaTdee ?? null,

    tdee_adaptive: tdeeData?.adaptiveTdee ?? null,

    tdee: resolvedTdee,
    remaining,
    deficit,
  };

  try {
    const averageWeightLast7Days = await getAverageWeightLast7Days(todayDate);
    const averageBodyFatLast7Days = await getAverageBodyFatLast7Days(todayDate);

    await saveDailyStatsSnapshot({
      date: todayDate,
      summary,
      weight: averageWeightLast7Days,
      bodyFat: averageBodyFatLast7Days,
      notes: JSON.stringify({
        mealsCount: meals.length,
        activitiesCount: activities.length,
        adaptiveModel: true,
      }),
    });
  } catch (error) {
    console.log("DAILY STATS SNAPSHOT SKIPPED", error.message);
  }

  return {
    date: todayDate,
    summary,
    meals,
  };
}

async function getAllMeals() {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:H",
  });

  return response.data.values || [];
}

module.exports = {
  appendMealRow,
  appendBodyRow,
  appendActivityRow,
  hasActivitySourceId,
  getLastBodyRow,
  getLatestWeight,
  getAverageWeightLast7Days,
  getAverageBodyFatLast7Days,
  getDynamicTdee,
  getAdaptiveTdeeLast14Days,
  getConfigValue,
  setConfigValue,
  upsertDailyStatsRow,
  saveDailyStatsSnapshot,
  getTodayRows,
  getTodayActivityRows,
  getTodayRunningTotal,
  getTodaySummary,
  getTodayDietReport,
  getAllMeals,
};
