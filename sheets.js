const { google } = require("googleapis");

const {
  insertBodyMetric,
  getLatestWeightFromPostgres,
} = require("./repositories/bodyRepository");
const { getMealsByDate } = require("./repositories/mealsRepository");
const { getActivitiesByDate } = require("./repositories/activityRepository");
const {
  getUserConfigValueFromPostgres,
} = require("./repositories/configRepository");
const {
  upsertDailyStatsSnapshot,
} = require("./repositories/dailyStatsRepository");
const { parseSheetNumber, roundNumber } = require("./utils/numbers-and-dates");
const {
  maybeEncryptBodyValue,
  maybeDecryptBodyNumber,
} = require("./utils/crypto");

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
  configValues: {
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

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

function getEncryptedBodyUserIds() {
  const raw = String(process.env.ENCRYPTED_BODY_USER_IDS || "elisa").trim();

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function shouldEncryptBodyForUser(userId) {
  return getEncryptedBodyUserIds().includes(normalizeUserId(userId));
}

function normalizeUserId(userId) {
  return (
    String(userId || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
}

// Helper to get user-specific config value, falling back to Google Sheets legacy config.
async function getUserConfigValue(key, userId) {
  const normalizedUserId = normalizeUserId(userId);

  try {
    const postgresValue = await getUserConfigValueFromPostgres(
      normalizedUserId,
      key,
    );

    if (
      postgresValue !== null &&
      postgresValue !== undefined &&
      postgresValue !== ""
    ) {
      return postgresValue;
    }
  } catch (error) {
    console.error(
      "POSTGRES CONFIG READ FAILED - FALLING BACK TO SHEETS",
      JSON.stringify({
        userId: normalizedUserId,
        key,
        message: error.message,
      }),
    );
  }

  const configValues = await getConfigValuesMap();
  const userSpecificValue = configValues.get(`${key}_${normalizedUserId}`);

  if (
    userSpecificValue !== null &&
    userSpecificValue !== undefined &&
    userSpecificValue !== ""
  ) {
    return userSpecificValue;
  }

  return configValues.get(key) || null;
}

function isIsoDateLike(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function hasUserIdColumn(row) {
  return !isIsoDateLike(row?.[0]) && isIsoDateLike(row?.[1]);
}

function getCacheDateKey(date, userId) {
  return `${normalizeUserId(userId)}:${date}`;
}

function normalizeMealRow(row, fallbackUserId = DEFAULT_USER_ID) {
  const hasUserId = hasUserIdColumn(row);
  const offset = hasUserId ? 1 : 0;

  return {
    user_id: normalizeUserId(hasUserId ? row[0] : fallbackUserId),
    date: String(row[offset + 0] || "").trim(),
    time: row[offset + 1] || "",
    meal_type: row[offset + 2] || "",
    description: row[offset + 3] || "",
    calories: parseSheetNumber(row[offset + 4]),
    protein: parseSheetNumber(row[offset + 5]),
    carbs: parseSheetNumber(row[offset + 6]),
    fat: parseSheetNumber(row[offset + 7]),
    raw: row,
  };
}

function normalizeActivityRow(row, fallbackUserId = DEFAULT_USER_ID) {
  const hasUserId = hasUserIdColumn(row);
  const offset = hasUserId ? 1 : 0;

  return {
    user_id: normalizeUserId(hasUserId ? row[0] : fallbackUserId),
    date: String(row[offset + 0] || "").trim(),
    time: row[offset + 1] || "",
    source: row[offset + 2] || "",
    activity_type: row[offset + 3] || "",
    description: row[offset + 4] || "",
    calories: parseSheetNumber(row[offset + 5]),
    distance_km: parseSheetNumber(row[offset + 6]),
    duration_min: parseSheetNumber(row[offset + 7]),
    steps: parseSheetNumber(row[offset + 8]),
    avg_speed_kmh: parseSheetNumber(row[offset + 9]),
    source_id: row[offset + 10] || "",
    source_url: row[offset + 11] || "",
    raw_json: row[offset + 12] || "",
    raw: row,
    offset,
  };
}

function toLegacyActivityRowForNormalizer(
  row,
  fallbackUserId = DEFAULT_USER_ID,
) {
  const activity = normalizeActivityRow(row, fallbackUserId);

  return [
    activity.date,
    activity.time,
    activity.source,
    activity.activity_type,
    activity.description,
    activity.calories,
    activity.distance_km,
    activity.duration_min,
    activity.steps,
    activity.avg_speed_kmh,
    activity.source_id,
    activity.source_url,
    activity.raw_json,
  ];
}

function normalizeBodyRow(row, fallbackUserId = DEFAULT_USER_ID) {
  const hasUserId = hasUserIdColumn(row);
  const offset = hasUserId ? 1 : 0;

  const encryptedAwareNumber = (value) => {
    if (value === "" || value == null) {
      return null;
    }

    return maybeDecryptBodyNumber(value);
  };

  return {
    user_id: normalizeUserId(hasUserId ? row[0] : fallbackUserId),
    date: String(row[offset + 0] || "").trim(),
    time: row[offset + 1] || "",
    source: row[offset + 2] || "",
    weight: encryptedAwareNumber(row[offset + 3]),
    bodyFat: encryptedAwareNumber(row[offset + 4]),
    muscleMass: encryptedAwareNumber(row[offset + 5]),
    waterMass: encryptedAwareNumber(row[offset + 6]),
    fatMass: encryptedAwareNumber(row[offset + 7]),
    leanMass: encryptedAwareNumber(row[offset + 8]),
    rawJson: row[offset + 9] || "",
    raw: row,
    offset,
  };
}

function encryptBodyRowForStorage(row) {
  const hasUserId = hasUserIdColumn(row);
  const userId = normalizeUserId(hasUserId ? row[0] : DEFAULT_USER_ID);

  if (!shouldEncryptBodyForUser(userId)) {
    return row;
  }

  const offset = hasUserId ? 1 : 0;
  const encryptedRow = [...row];

  for (const index of [3, 4, 5, 6, 7, 8]) {
    const columnIndex = offset + index;
    encryptedRow[columnIndex] = maybeEncryptBodyValue(
      userId,
      encryptedRow[columnIndex],
    );
  }

  return encryptedRow;
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
    range: row.length >= 9 ? "Meals!A:I" : "Meals!A:H",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  const meal = normalizeMealRow(row);
  const mealDate = meal.date;
  const mealUserId = meal.user_id;

  if (
    isCacheValid(cache.todayMeals) &&
    cache.todayMeals.value?.key === getCacheDateKey(mealDate, mealUserId)
  ) {
    setCache(cache.todayMeals, {
      key: getCacheDateKey(mealDate, mealUserId),
      date: mealDate,
      userId: mealUserId,
      rows: [...cache.todayMeals.value.rows, row],
    });
  }
}

async function appendBodyRow(row) {
  const sheets = await getSheetsClient();
  const rowForStorage = encryptBodyRowForStorage(row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: rowForStorage.length >= 11 ? "Body!A:K" : "Body!A:J",
    valueInputOption: "RAW",
    requestBody: {
      values: [rowForStorage],
    },
  });

  const body = normalizeBodyRow(rowForStorage);
  const offset = body.offset || 0;

  try {
    await insertBodyMetric({
      userSlug: body.user_id,
      date: body.date,
      time: body.time,
      source: body.source,
      weight: rowForStorage[offset + 3] ?? null,
      bodyFat: rowForStorage[offset + 4] ?? null,
      muscleMass: rowForStorage[offset + 5] ?? null,
      waterMass: rowForStorage[offset + 6] ?? null,
      fatMass: rowForStorage[offset + 7] ?? null,
      leanMass: rowForStorage[offset + 8] ?? null,
      rawJson: body.rawJson ? JSON.parse(body.rawJson) : null,
    });

    console.log("POSTGRES BODY INSERTED");
  } catch (error) {
    console.error("POSTGRES BODY INSERT FAILED", {
      message: error.message,
    });
  }

  let sourceDate = null;
  try {
    const rawGroup = JSON.parse(body.rawJson || "{}");
    sourceDate = rawGroup.date ?? null;
  } catch (error) {
    sourceDate = null;
  }

  const cachedBody = {
    user_id: body.user_id,
    date: body.date,
    time: body.time,
    source: body.source,
    weight: body.weight,
    bodyFat: body.bodyFat,
    muscleMass: body.muscleMass,
    waterMass: body.waterMass,
    fatMass: body.fatMass,
    leanMass: body.leanMass,
    rawJson: body.rawJson,
    sourceDate,
  };

  setCache(cache.lastBodyRow, cachedBody);

  console.log(
    "SHEET BODY ROW WRITTEN",
    JSON.stringify({
      userId: cachedBody.user_id,
      date: cachedBody.date,
      time: cachedBody.time,
      source: cachedBody.source,
      encrypted: shouldEncryptBodyForUser(cachedBody.user_id),
    }),
  );
}

async function appendActivityRow(row) {
  const sheets = await getSheetsClient();
  const activity = normalizeActivityRow(row);
  const sourceId = String(activity.source_id || "").trim();
  const date = activity.date;
  const source = activity.source;
  const userId = activity.user_id;
  const isWithingsSteps = sourceId.startsWith("withings-steps-");

  const updateTodayActivitiesCache = (updatedRow) => {
    if (
      !isCacheValid(cache.todayActivities) ||
      cache.todayActivities.value?.key !== getCacheDateKey(date, userId)
    ) {
      return;
    }

    const currentRows = [...(cache.todayActivities.value.rows || [])];
    const cachedIndex = currentRows.findIndex((cachedRow) => {
      const cachedActivity = normalizeActivityRow(cachedRow, userId);
      return (
        String(cachedActivity.source_id || "").trim() === sourceId &&
        cachedActivity.user_id === userId
      );
    });

    if (cachedIndex !== -1) {
      currentRows[cachedIndex] = updatedRow;
    } else {
      currentRows.push(updatedRow);
    }

    setCache(cache.todayActivities, {
      key: getCacheDateKey(date, userId),
      date,
      userId,
      rows: currentRows,
    });
  };

  const addSourceIdToCache = () => {
    if (!sourceId) {
      return;
    }

    const sourceIdsCacheKey = `activitySourceIds:${userId}`;
    const currentIds =
      isCacheValid(cache.activitySourceIds) &&
      cache.activitySourceIds.value?.key === sourceIdsCacheKey
        ? cache.activitySourceIds.value.sourceIds
        : [];

    if (!currentIds.includes(sourceId)) {
      setCache(cache.activitySourceIds, {
        key: sourceIdsCacheKey,
        userId,
        sourceIds: [...currentIds, sourceId],
      });
    }
  };

  if (sourceId) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "activity!A:N",
    });

    const rows = response.data.values || [];
    const existingIndex = rows.findIndex((existingRow, idx) => {
      if (idx === 0) return false;

      const existingActivity = normalizeActivityRow(existingRow, userId);

      return (
        String(existingActivity.source_id || "").trim() === sourceId &&
        existingActivity.user_id === userId
      );
    });

    if (existingIndex !== -1) {
      if (isWithingsSteps) {
        const sheetRowNumber = existingIndex + 1;

        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SHEET_ID,
          range: `activity!A${sheetRowNumber}:N${sheetRowNumber}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [row],
          },
        });

        updateTodayActivitiesCache(row);
        addSourceIdToCache();

        console.log(
          "SHEET ACTIVITY UPDATED",
          JSON.stringify({
            userId,
            sourceId,
            date,
            source,
            rowNumber: sheetRowNumber,
          }),
        );

        return {
          success: true,
          updated: true,
          sourceId,
          rowNumber: sheetRowNumber,
        };
      }

      console.log(
        "SHEET ACTIVITY SKIPPED DUPLICATE",
        JSON.stringify({
          userId,
          sourceId,
          date,
          source,
        }),
      );

      addSourceIdToCache();

      return {
        success: true,
        skipped: true,
        reason: "duplicate_source_id",
        sourceId,
      };
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: row.length >= 14 ? "activity!A:N" : "activity!A:M",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  console.log(
    "SHEET ACTIVITY ROW WRITTEN",
    JSON.stringify({
      userId,
      sourceId: sourceId || null,
      date,
      source,
    }),
  );

  addSourceIdToCache();

  if (
    isCacheValid(cache.todayActivities) &&
    cache.todayActivities.value?.key === getCacheDateKey(date, userId)
  ) {
    setCache(cache.todayActivities, {
      key: getCacheDateKey(date, userId),
      date,
      userId,
      rows: [...cache.todayActivities.value.rows, row],
    });
  }

  return {
    success: true,
    skipped: false,
    sourceId: sourceId || null,
  };
}

async function hasActivitySourceId(sourceId, userId = DEFAULT_USER_ID) {
  if (!sourceId) {
    return false;
  }

  const normalizedUserId = normalizeUserId(userId);
  const normalizedSourceId = String(sourceId || "").trim();
  const cacheKey = `activitySourceIds:${normalizedUserId}`;

  if (
    isCacheValid(cache.activitySourceIds) &&
    cache.activitySourceIds.value?.key === cacheKey
  ) {
    return cache.activitySourceIds.value.sourceIds.includes(normalizedSourceId);
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!A:N",
  });

  const sourceIds = (response.data.values || [])
    .slice(1)
    .map((row) => normalizeActivityRow(row))
    .filter((activity) => activity.user_id === normalizedUserId)
    .map((activity) => String(activity.source_id || "").trim())
    .filter(Boolean);

  setCache(cache.activitySourceIds, {
    key: cacheKey,
    userId: normalizedUserId,
    sourceIds,
  });

  return sourceIds.includes(normalizedSourceId);
}

async function getLastBodyRow(userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);

  if (
    isCacheValid(cache.lastBodyRow) &&
    cache.lastBodyRow.value?.user_id === normalizedUserId
  ) {
    return cache.lastBodyRow.value;
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Body!A:K",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.lastBodyRow, null);
    return null;
  }

  const matchingRows = rows
    .slice(1)
    .map((row) => normalizeBodyRow(row, normalizedUserId))
    .filter((row) => row.user_id === normalizedUserId);

  if (matchingRows.length === 0) {
    setCache(cache.lastBodyRow, null);
    return null;
  }

  const last = matchingRows[matchingRows.length - 1];
  let sourceDate = null;

  try {
    const rawGroup = JSON.parse(last.rawJson || "{}");
    sourceDate = rawGroup.date ?? null;
  } catch (error) {
    sourceDate = null;
  }

  const result = {
    user_id: last.user_id,
    date: last.date,
    time: last.time,
    source: last.source,
    weight: last.weight,
    bodyFat: last.bodyFat,
    muscleMass: last.muscleMass,
    waterMass: last.waterMass,
    fatMass: last.fatMass,
    leanMass: last.leanMass,
    rawJson: last.rawJson,
    sourceDate,
  };

  setCache(cache.lastBodyRow, result);

  return result;
}

async function getLatestWeight(userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);

  try {
    const postgresWeight = await getLatestWeightFromPostgres(normalizedUserId);

    if (postgresWeight != null) {
      return postgresWeight;
    }
  } catch (error) {
    console.error("POSTGRES LATEST WEIGHT READ FAILED", {
      userId: normalizedUserId,
      message: error.message,
    });
  }

  const last = await getLastBodyRow(normalizedUserId);

  if (!last || last.weight == null) {
    return null;
  }

  const parsedWeight = Number(String(last.weight).replace(",", "."));

  return Number.isFinite(parsedWeight) ? parsedWeight : null;
}

async function getConfigValuesMap() {
  if (isCacheValid(cache.configValues)) {
    return cache.configValues.value;
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Config!A:B",
  });

  const rows = response.data.values || [];
  const values = new Map();

  for (let i = 1; i < rows.length; i++) {
    const rowKey = rows[i][0];
    const rowValue = rows[i][1];

    if (rowKey) {
      values.set(String(rowKey).trim(), rowValue || null);
    }
  }

  setCache(cache.configValues, values);

  return values;
}

async function getConfigValue(key) {
  const values = await getConfigValuesMap();
  return values.get(key) || null;
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

      cache.configValues.value = null;
      cache.configValues.expiresAt = 0;

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

  cache.configValues.value = null;
  cache.configValues.expiresAt = 0;
}

async function upsertDailyStatsRow(row) {
  const sheets = await getSheetsClient();
  const hasUserId = hasUserIdColumn(row);
  const userId = normalizeUserId(hasUserId ? row[0] : DEFAULT_USER_ID);
  const date = String(row[hasUserId ? 1 : 0] || "").trim();

  if (!date) {
    throw new Error("DailyStats row missing date");
  }

  const normalizedRow = hasUserId ? row : [userId, ...row];

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "DailyStats!A:M",
  });

  const rows = response.data.values || [];
  const existingIndex = rows.findIndex((existingRow, idx) => {
    if (idx === 0) return false;

    const existingHasUserId = hasUserIdColumn(existingRow);
    const existingUserId = normalizeUserId(
      existingHasUserId ? existingRow[0] : DEFAULT_USER_ID,
    );
    const existingDate = String(
      existingRow[existingHasUserId ? 1 : 0] || "",
    ).trim();

    return existingUserId === userId && existingDate === date;
  });

  if (existingIndex !== -1) {
    const rowNumber = existingIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `DailyStats!A${rowNumber}:M${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [normalizedRow],
      },
    });

    console.log(
      "DAILY STATS ROW UPDATED",
      JSON.stringify({
        userId,
        date,
        rowNumber,
        intake: normalizedRow[2],
        activity: normalizedRow[3],
        net: normalizedRow[4],
        target: normalizedRow[5],
        tdeeFinal: normalizedRow[8],
        deficit: normalizedRow[9],
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
    range: "DailyStats!A:M",
    valueInputOption: "RAW",
    requestBody: {
      values: [normalizedRow],
    },
  });

  console.log(
    "DAILY STATS ROW APPENDED",
    JSON.stringify({
      userId,
      date,
      intake: normalizedRow[2],
      activity: normalizedRow[3],
      net: normalizedRow[4],
      target: normalizedRow[5],
      tdeeFinal: normalizedRow[8],
      deficit: normalizedRow[9],
    }),
  );

  return {
    success: true,
    updated: false,
  };
}

async function upsertWeeklyStatsRow(data) {
  const sheets = await getSheetsClient();
  const userId = normalizeUserId(data.user_id || data.userId);
  const weekStart = String(data.week_start || "").trim();

  if (!weekStart) {
    throw new Error("WeeklyStats row missing week_start");
  }

  const row = [
    userId,
    data.week_start || "",
    data.week_end || "",
    data.intake ?? 0,
    data.activity ?? 0,
    data.net ?? 0,
    data.target ?? 0,
    data.remaining ?? 0,
    data.protein ?? 0,
    data.carbs ?? 0,
    data.fat ?? 0,
    data.recent_meals_json || "[]",
    data.food_frequency_json || "{}",
    data.variety_warnings_json || "[]",
    data.generated_at || new Date().toISOString(),
    data.source || "refresh",
  ];

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "WeeklyStats!A:P",
  });

  const rows = response.data.values || [];
  const existingIndex = rows.findIndex((existingRow, idx) => {
    if (idx === 0) return false;

    const existingUserId = normalizeUserId(existingRow[0]);
    const existingWeekStart = String(existingRow[1] || "").trim();

    return existingUserId === userId && existingWeekStart === weekStart;
  });

  if (existingIndex !== -1) {
    const rowNumber = existingIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `WeeklyStats!A${rowNumber}:P${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });

    return {
      success: true,
      updated: true,
      rowNumber,
    };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "WeeklyStats!A:P",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  return {
    success: true,
    updated: false,
  };
}

async function saveDailyStatsSnapshot({
  userId = DEFAULT_USER_ID,
  date,
  summary,
  weight,
  bodyFat,
  notes,
}) {
  const normalizedUserId = normalizeUserId(userId);

  const snapshot = {
    date,
    intake: summary?.intake ?? 0,
    activity: Math.abs(Number(summary?.activity || 0)),
    net: summary?.net ?? 0,
    target: summary?.target ?? 0,
    remaining: summary?.remaining ?? 0,
    protein: summary?.protein ?? 0,
    carbs: summary?.carbs ?? 0,
    fat: summary?.fat ?? 0,
    weight: weight ?? null,
    bodyFat: bodyFat ?? null,
    tdeeFormula: summary?.tdee_formula ?? null,
    tdeeAdaptive: summary?.tdee_adaptive ?? null,
    tdeeFinal: summary?.tdee ?? null,
    source: "runtime",
    notes: notes || null,
  };

  try {
    const result = await upsertDailyStatsSnapshot(normalizedUserId, snapshot);

    console.log(
      "POSTGRES DAILY STATS SNAPSHOT SAVED",
      JSON.stringify({
        userId: normalizedUserId,
        date,
        intake: snapshot.intake,
        activity: snapshot.activity,
        net: snapshot.net,
        target: snapshot.target,
        remaining: snapshot.remaining,
        tdeeFinal: snapshot.tdeeFinal,
        weight: snapshot.weight,
        bodyFat: snapshot.bodyFat,
      }),
    );

    return result;
  } catch (error) {
    console.error(
      "POSTGRES DAILY STATS SNAPSHOT FAILED - FALLING BACK TO SHEETS",
      JSON.stringify({
        userId: normalizedUserId,
        date,
        message: error.message,
      }),
    );
  }

  const row = [
    normalizedUserId,
    date,
    snapshot.intake,
    snapshot.activity,
    snapshot.net,
    snapshot.target,
    snapshot.tdeeFormula ?? "",
    snapshot.tdeeAdaptive ?? "",
    snapshot.tdeeFinal ?? "",
    summary?.deficit ?? 0,
    snapshot.weight ?? "",
    snapshot.bodyFat ?? "",
    notes || "",
  ];

  const result = await upsertDailyStatsRow(row);

  console.log(
    "DAILY STATS SNAPSHOT SAVED",
    JSON.stringify({
      userId: normalizedUserId,
      date,
      updated: result?.updated ?? false,
      intake: row[2],
      activity: row[3],
      net: row[4],
      target: row[5],
      tdeeFinal: row[8],
      deficit: row[9],
      weight: row[10],
      bodyFat: row[11],
    }),
  );

  return result;
}

async function saveKitchenState(recipe) {
  const sheets = await getSheetsClient();

  const state = {
    updatedAt: new Date().toISOString(),
    recipe: {
      title: recipe.title,
      servings: recipe.servings ?? "",
      ingredients: recipe.ingredients || [],
      steps: recipe.steps || [],
      notes: recipe.notes || "",
    },
  };

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: "Kitchen!A2:F2",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          state.updatedAt,
          state.recipe.title,
          state.recipe.servings,
          JSON.stringify(state.recipe.ingredients),
          JSON.stringify(state.recipe.steps),
          state.recipe.notes,
        ],
      ],
    },
  });

  return state;
}

async function getKitchenState() {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Kitchen!A2:F2",
  });

  const row = response.data.values?.[0];

  if (!row || row.length === 0) {
    return {
      updatedAt: null,
      recipe: null,
    };
  }

  return {
    updatedAt: row[0] || null,
    recipe: {
      title: row[1] || "",
      servings: row[2] ? Number(row[2]) : null,
      ingredients: row[3] ? JSON.parse(row[3]) : [],
      steps: row[4] ? JSON.parse(row[4]) : [],
      notes: row[5] || "",
    },
  };
}

async function saveSilviaMealState(payload) {
  const sheets = await getSheetsClient();

  const updatedAt = new Date().toISOString();

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: "SilviaMeal!A2:B2",
    valueInputOption: "RAW",
    requestBody: {
      values: [[updatedAt, JSON.stringify(payload)]],
    },
  });

  return {
    updatedAt,
    payload,
  };
}

async function getSilviaMealState() {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "SilviaMeal!A2:B2",
  });

  const row = response.data.values?.[0];

  if (!row || row.length === 0) {
    return {
      updatedAt: null,
      payload: null,
    };
  }

  try {
    return {
      updatedAt: row[0] || null,
      payload: row[1] ? JSON.parse(row[1]) : null,
    };
  } catch (error) {
    console.error(
      "SILVIA MEAL JSON PARSE FAILED",
      JSON.stringify({
        updatedAt: row[0] || null,
        error: error.message,
      }),
    );

    return {
      updatedAt: row[0] || null,
      payload: null,
    };
  }
}

function getWeekRangeMondaySunday(referenceDate) {
  const date = new Date(`${referenceDate}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid reference date: ${referenceDate}`);
  }

  const day = date.getUTCDay();

  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(date);

  monday.setUTCDate(date.getUTCDate() + diffToMonday);

  const sunday = new Date(monday);

  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    weekStart: monday.toISOString().slice(0, 10),

    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

function isDateInRange(date, startDate, endDate) {
  const value = String(date || "").trim();

  return value >= startDate && value <= endDate;
}

function buildFoodFrequency(meals) {
  const patterns = [
    { key: "uova", regex: /\b(uovo|uova|albume|albumi)\b/i },

    { key: "yogurt greco", regex: /\byogurt\s+greco\b/i },

    { key: "yogurt", regex: /\byogurt\b/i },

    { key: "tonno", regex: /\btonno\b/i },

    { key: "pollo", regex: /\bpollo\b/i },

    { key: "tacchino", regex: /\btacchino\b/i },

    {
      key: "carne rossa",

      regex: /\b(manzo|bovino|hamburger|vitello|maiale|salsiccia)\b/i,
    },

    {
      key: "pesce",

      regex: /\b(pesce|salmone|merluzzo|orata|branzino|sgombro|gamberi)\b/i,
    },

    { key: "fiocchi di latte", regex: /\bfiocchi\s+di\s+latte\b/i },

    { key: "latte", regex: /\blatte\b/i },

    { key: "mozzarella", regex: /\bmozzarella\b/i },

    { key: "pasta", regex: /\bpasta\b/i },

    { key: "riso", regex: /\briso\b/i },

    { key: "piadina", regex: /\bpiadina\b/i },

    { key: "pane", regex: /\bpane\b/i },

    { key: "patate", regex: /\bpatat(e|a)\b/i },

    { key: "banana", regex: /\bbanana\b/i },

    { key: "mela", regex: /\bmela\b/i },
  ];

  const frequency = {};

  for (const meal of meals) {
    const description = String(meal.description || "");

    for (const pattern of patterns) {
      if (pattern.regex.test(description)) {
        frequency[pattern.key] = (frequency[pattern.key] || 0) + 1;
      }
    }
  }

  return frequency;
}

function buildVarietyWarnings(foodFrequency) {
  const warnings = [];

  if ((foodFrequency.uova || 0) >= 4) {
    warnings.push(
      "Uova già frequenti questa settimana: evita di proporle se ci sono alternative.",
    );
  }

  if ((foodFrequency.tonno || 0) >= 2) {
    warnings.push(
      "Tonno già usato più volte questa settimana: meglio alternare con altro pesce o proteine diverse.",
    );
  }

  if ((foodFrequency["yogurt greco"] || 0) >= 3) {
    warnings.push(
      "Yogurt greco già frequente questa settimana: evita ridondanza negli spuntini.",
    );
  }

  if ((foodFrequency.pollo || 0) >= 3) {
    warnings.push(
      "Pollo già frequente questa settimana: varia con legumi, pesce, latticini o altre proteine.",
    );
  }

  if ((foodFrequency.piadina || 0) >= 3) {
    warnings.push(
      "Piadina già frequente questa settimana: varia la fonte di carboidrati.",
    );
  }

  return warnings;
}

async function getMealRowsByDateRange(
  startDate,
  endDate,
  userId = DEFAULT_USER_ID,
) {
  const sheets = await getSheetsClient();
  const normalizedUserId = normalizeUserId(userId);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:I",
  });

  const rows = response.data.values || [];

  return rows.slice(1).filter((row) => {
    const meal = normalizeMealRow(row, normalizedUserId);
    return (
      meal.user_id === normalizedUserId &&
      isDateInRange(meal.date, startDate, endDate)
    );
  });
}

async function getActivityRowsByDateRange(
  startDate,
  endDate,
  userId = DEFAULT_USER_ID,
) {
  const sheets = await getSheetsClient();
  const normalizedUserId = normalizeUserId(userId);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!A:N",
  });

  const rows = response.data.values || [];

  return rows.slice(1).filter((row) => {
    const activity = normalizeActivityRow(row, normalizedUserId);
    return (
      activity.user_id === normalizedUserId &&
      isDateInRange(activity.date, startDate, endDate)
    );
  });
}

async function getWeekDietContext(referenceDate, options = {}) {
  const userId = normalizeUserId(options.userId);
  const { weekStart, weekEnd } = getWeekRangeMondaySunday(referenceDate);

  const mealRows = await getMealRowsByDateRange(weekStart, weekEnd, userId);

  const activityRows = await getActivityRowsByDateRange(
    weekStart,
    weekEnd,
    userId,
  );

  const meals = mealRows.map((row) => {
    const meal = normalizeMealRow(row, userId);

    return {
      date: meal.date,
      time: meal.time,
      meal_type: meal.meal_type,
      description: meal.description,
      calories: meal.calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
    };
  });

  const activitiesByDate = {};

  const mealTotalsByDate = {};

  for (const meal of meals) {
    if (!mealTotalsByDate[meal.date]) {
      mealTotalsByDate[meal.date] = {
        intake: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        mealsCount: 0,
      };
    }

    mealTotalsByDate[meal.date].intake += meal.calories;
    mealTotalsByDate[meal.date].protein += meal.protein;
    mealTotalsByDate[meal.date].carbs += meal.carbs;
    mealTotalsByDate[meal.date].fat += meal.fat;
    mealTotalsByDate[meal.date].mealsCount += 1;
  }

  for (const row of activityRows) {
    const activity = normalizeActivityRow(row, userId);
    const date = activity.date;

    if (!activitiesByDate[date]) {
      activitiesByDate[date] = [];
    }

    activitiesByDate[date].push(row);
  }

  const days = [];

  let totalIntake = 0;
  let totalActivity = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalTarget = 0;
  let totalDeficit = 0;

  const start = new Date(`${weekStart}T00:00:00Z`);
  const manualTarget =
    parseSheetNumber(await getUserConfigValue("diet_target_manual", userId)) ||
    1750;

  for (let i = 0; i < 7; i++) {
    const current = new Date(start);
    current.setUTCDate(start.getUTCDate() + i);
    const date = current.toISOString().slice(0, 10);

    const mealTotals = mealTotalsByDate[date] || {
      intake: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      mealsCount: 0,
    };

    const normalizedActivities = buildNormalizedActivityEntries(
      (activitiesByDate[date] || []).map((row) =>
        toLegacyActivityRowForNormalizer(row, userId),
      ),
    );

    const activity = roundNumber(
      normalizedActivities.reduce((sum, entry) => sum + entry.calories, 0),
      0,
    );

    const intake = roundNumber(mealTotals.intake, 0);
    const net = roundNumber(intake + activity, 0);
    const target = manualTarget;
    const deficit = roundNumber(target - net, 0);

    if (target != null) {
      totalTarget += target;
    }
    if (deficit != null) {
      totalDeficit += deficit;
    }

    totalIntake += intake;
    totalActivity += activity;
    totalProtein += mealTotals.protein;
    totalCarbs += mealTotals.carbs;
    totalFat += mealTotals.fat;

    days.push({
      date,
      intake,
      activity,
      net,
      target,
      remaining: deficit,
      protein: roundNumber(mealTotals.protein, 1),
      carbs: roundNumber(mealTotals.carbs, 1),
      fat: roundNumber(mealTotals.fat, 1),
      meals_count: mealTotals.mealsCount,
      activities_count: normalizedActivities.length,
    });
  }

  const foodFrequency = buildFoodFrequency(meals);

  return {
    user_id: userId,
    week_start: weekStart,
    week_end: weekEnd,
    summary: {
      intake: roundNumber(totalIntake, 0),
      activity: roundNumber(totalActivity, 0),
      net: roundNumber(totalIntake + totalActivity, 0),
      target: roundNumber(totalTarget, 0),
      remaining: roundNumber(totalDeficit, 0),
      protein: roundNumber(totalProtein, 1),
      carbs: roundNumber(totalCarbs, 1),
      fat: roundNumber(totalFat, 1),
      avg_daily_intake: roundNumber(totalIntake / 7, 0),
      avg_daily_net: roundNumber((totalIntake + totalActivity) / 7, 0),
    },
    days,
    recent_meals: meals.slice(-20).map((meal) => ({
      date: meal.date,
      meal_type: meal.meal_type,
      description: meal.description,
      calories: meal.calories,
    })),
    food_frequency: foodFrequency,
    variety_warnings: buildVarietyWarnings(foodFrequency),
  };
}
async function getTodayRows(todayDate, userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);
  const cacheKey = getCacheDateKey(todayDate, normalizedUserId);

  if (
    isCacheValid(cache.todayMeals) &&
    cache.todayMeals.value?.key === cacheKey
  ) {
    return cache.todayMeals.value.rows;
  }

  try {
    const postgresRows = await getMealsByDate(normalizedUserId, todayDate);

    setCache(cache.todayMeals, {
      key: cacheKey,
      date: todayDate,
      userId: normalizedUserId,
      rows: postgresRows,
      source: "postgres",
    });

    console.log(
      "POSTGRES TODAY MEALS READ",
      JSON.stringify({
        userId: normalizedUserId,
        date: todayDate,
        count: postgresRows.length,
      }),
    );

    return postgresRows;
  } catch (error) {
    console.error(
      "POSTGRES TODAY MEALS READ FAILED - FALLING BACK TO SHEETS",
      JSON.stringify({
        userId: normalizedUserId,
        date: todayDate,
        message: error.message,
      }),
    );
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:I",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.todayMeals, {
      key: cacheKey,
      date: todayDate,
      userId: normalizedUserId,
      rows: [],
      source: "sheets",
    });
    return [];
  }

  const filtered = rows.slice(1).filter((row) => {
    const meal = normalizeMealRow(row, normalizedUserId);
    return meal.user_id === normalizedUserId && meal.date === todayDate;
  });

  setCache(cache.todayMeals, {
    key: cacheKey,
    date: todayDate,
    userId: normalizedUserId,
    rows: filtered,
    source: "sheets",
  });

  return filtered;
}

async function getTodayActivityRows(todayDate, userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);
  const cacheKey = getCacheDateKey(todayDate, normalizedUserId);

  if (
    isCacheValid(cache.todayActivities) &&
    cache.todayActivities.value?.key === cacheKey
  ) {
    return cache.todayActivities.value.rows;
  }

  try {
    const postgresRows = await getActivitiesByDate(normalizedUserId, todayDate);

    setCache(cache.todayActivities, {
      key: cacheKey,
      date: todayDate,
      userId: normalizedUserId,
      rows: postgresRows,
      source: "postgres",
    });

    console.log(
      "POSTGRES TODAY ACTIVITIES READ",
      JSON.stringify({
        userId: normalizedUserId,
        date: todayDate,
        count: postgresRows.length,
      }),
    );

    return postgresRows;
  } catch (error) {
    console.error(
      "POSTGRES TODAY ACTIVITIES READ FAILED - FALLING BACK TO SHEETS",
      JSON.stringify({
        userId: normalizedUserId,
        date: todayDate,
        message: error.message,
      }),
    );
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "activity!A:N",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    setCache(cache.todayActivities, {
      key: cacheKey,
      date: todayDate,
      userId: normalizedUserId,
      rows: [],
      source: "sheets",
    });
    return [];
  }

  const filtered = rows.slice(1).filter((row) => {
    const activity = normalizeActivityRow(row, normalizedUserId);
    return activity.user_id === normalizedUserId && activity.date === todayDate;
  });

  setCache(cache.todayActivities, {
    key: cacheKey,
    date: todayDate,
    userId: normalizedUserId,
    rows: filtered,
    source: "sheets",
  });

  return filtered;
}

async function getTodayRunningTotal(todayDate, userId = DEFAULT_USER_ID) {
  const rows = await getTodayRows(todayDate, userId);

  return rows.reduce((sum, row) => {
    const meal = normalizeMealRow(row, userId);
    return sum + meal.calories;
  }, 0);
}

async function getTodaySummary(todayDate, userId = DEFAULT_USER_ID) {
  const rows = await getTodayRows(todayDate, userId);

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;

  for (const row of rows) {
    const meal = normalizeMealRow(row, userId);
    calories += meal.calories;
    protein += meal.protein;
    carbs += meal.carbs;
    fat += meal.fat;
  }

  return {
    calories,
    protein,
    carbs,
    fat,
    count: rows.length,
  };
}

async function getTodayDietReport(
  todayDate,
  targetCalories = null,
  options = {},
) {
  const { skipDailyStatsSnapshot = false } = options;
  const userId = normalizeUserId(options.userId);
  const reportStartedAt = Date.now();
  let stepStartedAt = reportStartedAt;

  const logStepTime = (step) => {
    const now = Date.now();
    console.log(
      "DIET REPORT TIMING",
      JSON.stringify({
        userId,
        date: todayDate,
        step,
        stepMs: now - stepStartedAt,
        totalMs: now - reportStartedAt,
      }),
    );
    stepStartedAt = now;
  };

  const rows = await getTodayRows(todayDate, userId);
  logStepTime("getTodayRows");

  const activityRows = await getTodayActivityRows(todayDate, userId);
  logStepTime("getTodayActivityRows");

  let runningTotal = 0;

  const meals = rows.map((row) => {
    const meal = normalizeMealRow(row, userId);
    const calories = meal.calories;
    runningTotal += calories;

    return {
      user_id: meal.user_id,
      date: meal.date,
      time: meal.time,
      meal_type: meal.meal_type,
      description: meal.description,
      calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
      running_total: runningTotal,
    };
  });

  const activities = buildNormalizedActivityEntries(
    activityRows.map((row) => toLegacyActivityRowForNormalizer(row, userId)),
  );
  logStepTime("buildNormalizedActivityEntries");

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

  const targetMode = String(
    (await getUserConfigValue("diet_target_mode", userId)) || "manual",
  )
    .trim()
    .toLowerCase();

  const manualTarget =
    parseSheetNumber(await getUserConfigValue("diet_target_manual", userId)) ||
    1750;

  const deficitKcal =
    parseSheetNumber(await getUserConfigValue("diet_deficit_kcal", userId)) ||
    700;
  logStepTime("configValues");

  const explicitTarget =
    targetCalories == null || targetCalories === ""
      ? null
      : Number(targetCalories);

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
    userId,
  });
  logStepTime("getDynamicTdee");

  const resolvedTdee =
    tdeeData?.finalTdee ?? roundNumber(manualTarget + deficitKcal, 0);

  let resolvedTarget = roundNumber(manualTarget, 0);

  if (explicitTarget != null && Number.isFinite(explicitTarget)) {
    resolvedTarget = roundNumber(explicitTarget, 0);
  } else if (targetMode === "dynamic") {
    resolvedTarget = roundNumber(resolvedTdee - deficitKcal, 0);
  }

  const remaining = roundNumber(resolvedTarget - net, 0);
  const deficit = roundNumber(resolvedTdee - net, 0);

  const summary = {
    intake,
    activity,
    net,
    protein,
    carbs,
    fat,
    target: resolvedTarget,
    tdee_formula: tdeeData?.formulaTdee ?? null,
    tdee_adaptive: tdeeData?.adaptiveTdee ?? null,
    tdee: resolvedTdee,
    remaining,
    deficit,
  };

  if (!skipDailyStatsSnapshot) {
    try {
      const averageWeightLast7Days = tdeeData?.averageWeightLast7Days ?? null;
      const averageBodyFatLast7Days = tdeeData?.averageBodyFatLast7Days ?? null;
      logStepTime("reuseTdeeAveragesForSnapshot");

      await saveDailyStatsSnapshot({
        userId,
        date: todayDate,
        summary,
        weight: averageWeightLast7Days,
        bodyFat: averageBodyFatLast7Days,
        notes: JSON.stringify({
          userId,
          mealsCount: meals.length,
          activitiesCount: activities.length,
          adaptiveModel: true,
        }),
      });
      logStepTime("saveDailyStatsSnapshot");
    } catch (error) {
      console.log("DAILY STATS SNAPSHOT SKIPPED", error.message);
    }
  }

  logStepTime("totalBeforeReturn");
  return {
    date: todayDate,
    user_id: userId,
    summary,
    meals,
  };
}

async function getAllMeals() {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Meals!A:I",
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
  upsertWeeklyStatsRow,
  saveDailyStatsSnapshot,
  getTodayRows,
  getTodayActivityRows,
  getTodayRunningTotal,
  getTodaySummary,
  getTodayDietReport,
  getWeekDietContext,
  getAllMeals,
  saveKitchenState,
  getKitchenState,
  saveSilviaMealState,
  getSilviaMealState,
};
