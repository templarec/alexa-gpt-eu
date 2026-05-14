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

const DEFAULT_USER_ID = "lorenzo";

function normalizeUserId(userId) {
  return (
    String(userId || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
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

function normalizeBodyRow(row, fallbackUserId = DEFAULT_USER_ID) {
  const hasUserId = hasUserIdColumn(row);
  const offset = hasUserId ? 1 : 0;

  return {
    user_id: normalizeUserId(hasUserId ? row[0] : fallbackUserId),
    date: String(row[offset + 0] || "").trim(),
    time: row[offset + 1] || "",
    source: row[offset + 2] || "",
    weight: parseSheetNumber(row[offset + 3]),
    bodyFat:
      row[offset + 4] === "" || row[offset + 4] == null
        ? null
        : parseSheetNumber(row[offset + 4]),
    muscleMass:
      row[offset + 5] === "" || row[offset + 5] == null
        ? null
        : parseSheetNumber(row[offset + 5]),
    waterMass:
      row[offset + 6] === "" || row[offset + 6] == null
        ? null
        : parseSheetNumber(row[offset + 6]),
    fatMass:
      row[offset + 7] === "" || row[offset + 7] == null
        ? null
        : parseSheetNumber(row[offset + 7]),
    leanMass:
      row[offset + 8] === "" || row[offset + 8] == null
        ? null
        : parseSheetNumber(row[offset + 8]),
    rawJson: row[offset + 9] || "",
    raw: row,
    offset,
  };
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

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: row.length >= 11 ? "Body!A:K" : "Body!A:J",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });

  const body = normalizeBodyRow(row);

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
      date: cachedBody.date,
      time: cachedBody.time,
      source: cachedBody.source,
      weight: cachedBody.weight,
    }),
  );
}

async function appendActivityRow(row) {
  const sheets = await getSheetsClient();
  const activity = normalizeActivityRow(row);
  const sourceId = activity.source_id;
  const date = activity.date;
  const source = activity.source;
  const userId = activity.user_id;

  if (sourceId && (await hasActivitySourceId(sourceId, userId))) {
    if (String(sourceId).startsWith("withings-steps-")) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: "activity!A:N",
      });

      const rows = res.data.values || [];
      const existingIndex = rows.findIndex((r, idx) => {
        if (idx === 0) return false;
        const existingActivity = normalizeActivityRow(r);
        return (
          existingActivity.source_id === String(sourceId) &&
          existingActivity.user_id === userId
        );
      });

      if (existingIndex !== -1) {
        const sheetRowNumber = existingIndex + 1;

        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SHEET_ID,
          range: `activity!A${sheetRowNumber}:N${sheetRowNumber}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [row],
          },
        });

        if (
          isCacheValid(cache.todayActivities) &&
          cache.todayActivities.value?.key === getCacheDateKey(date, userId)
        ) {
          const currentRows = [...(cache.todayActivities.value.rows || [])];
          const cachedIndex = currentRows.findIndex(
            (r) => normalizeActivityRow(r).source_id === String(sourceId),
          );

          if (cachedIndex !== -1) {
            currentRows[cachedIndex] = row;
          } else {
            currentRows.push(row);
          }

          setCache(cache.todayActivities, {
            key: getCacheDateKey(date, userId),
            date,
            userId,
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
    range: row.length >= 14 ? "activity!A:N" : "activity!A:M",
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
    const sourceIdsCacheKey = `activitySourceIds:${userId}`;
    const currentIds =
      isCacheValid(cache.activitySourceIds) &&
      cache.activitySourceIds.value?.key === sourceIdsCacheKey
        ? cache.activitySourceIds.value.sourceIds
        : [];

    if (!currentIds.includes(String(sourceId))) {
      setCache(cache.activitySourceIds, {
        key: sourceIdsCacheKey,
        userId,
        sourceIds: [...currentIds, String(sourceId)],
      });
    }
  }

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
    sourceId: sourceId ? String(sourceId) : null,
  };
}

async function hasActivitySourceId(sourceId, userId = DEFAULT_USER_ID) {
  if (!sourceId) {
    return false;
  }

  const normalizedUserId = normalizeUserId(userId);
  const cacheKey = `activitySourceIds:${normalizedUserId}`;

  if (
    isCacheValid(cache.activitySourceIds) &&
    cache.activitySourceIds.value?.key === cacheKey
  ) {
    return cache.activitySourceIds.value.sourceIds.includes(String(sourceId));
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
    .map((activity) => String(activity.source_id || ""))
    .filter(Boolean);

  setCache(cache.activitySourceIds, {
    key: cacheKey,
    userId: normalizedUserId,
    sourceIds,
  });

  return sourceIds.includes(String(sourceId));
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
  const last = await getLastBodyRow(userId);

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

async function upsertWeeklyStatsRow(data) {
  const sheets = await getSheetsClient();
  const weekStart = String(data.week_start || "").trim();

  if (!weekStart) {
    throw new Error("WeeklyStats row missing week_start");
  }

  const row = [
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
    range: "WeeklyStats!A:O",
  });

  const rows = response.data.values || [];
  const existingIndex = rows.findIndex(
    (existingRow, idx) =>
      idx > 0 && String(existingRow[0] || "").trim() === weekStart,
  );

  if (existingIndex !== -1) {
    const rowNumber = existingIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `WeeklyStats!A${rowNumber}:O${rowNumber}`,
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
    range: "WeeklyStats!A:O",
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
    parseSheetNumber(await getConfigValue("diet_target_manual")) || 1750;

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
      activitiesByDate[date] || [],
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

  const rows = await getTodayRows(todayDate, userId);
  const activityRows = await getTodayActivityRows(todayDate, userId);

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

  const targetMode = String(
    (await getConfigValue("diet_target_mode")) || "manual",
  )
    .trim()
    .toLowerCase();

  const manualTarget =
    parseSheetNumber(await getConfigValue("diet_target_manual")) || 1750;

  const deficitKcal =
    parseSheetNumber(await getConfigValue("diet_deficit_kcal")) || 700;

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
  });

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
          userId,
          mealsCount: meals.length,
          activitiesCount: activities.length,
          adaptiveModel: true,
        }),
      });
    } catch (error) {
      console.log("DAILY STATS SNAPSHOT SKIPPED", error.message);
    }
  }

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
