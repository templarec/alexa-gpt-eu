const { google } = require("googleapis");
const { parseSheetNumber, roundNumber } = require("./utils/numbers-and-dates");

const {
  buildNormalizedActivityEntries,
} = require("./utils/activity-normalizer");

const {
  getAverageWeightLast7Days,
  getAverageBodyFatLast7Days,
  getAdaptiveTdeeLast14Days,
  getDynamicTdee,
} = require("./utils/tdee");

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
  const tdeeData = await getDynamicTdee({
    sheets: await getSheetsClient(),
    spreadsheetId: process.env.SHEET_ID,
    getConfigValue,
    todayActivityKcal: activity,
    todayDate,
    fallbackWeightKg: Number(process.env.USER_WEIGHT_KG || 95),
    fallbackSex: process.env.USER_SEX || "male",
    fallbackAge: Number(process.env.USER_AGE) || 31,
    fallbackHeightCm: Number(process.env.USER_HEIGHT_CM) || 181,
    fallbackBaseActivityFactor: Number(process.env.BASE_ACTIVITY_FACTOR) || 1.2,
  });

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
    const sheets = await getSheetsClient();

    const averageWeightLast7Days = await getAverageWeightLast7Days(
      sheets,
      process.env.SHEET_ID,
      todayDate,
    );

    const averageBodyFatLast7Days = await getAverageBodyFatLast7Days(
      sheets,
      process.env.SHEET_ID,
      todayDate,
    );

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
