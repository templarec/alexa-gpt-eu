const fs = require("fs");
const path = require("path");
const Alexa = require("ask-sdk-core");
const { askChat, analyzeMeal } = require("./openai");
const { query } = require("./db/postgres");
const { getTodayDietReport } = require("./services/dietReport");
const { getWeekDietContext } = require("./services/weekContext");
const {
  upsertWeeklyStatsSnapshot,
} = require("./repositories/weeklyStatsRepository");
const { getDateTimeParts } = require("./utils");
const { normalizeNumbers } = require("./numberNormalizer");
const { TIMEZONE } = require("./config");
const { authorizeHttpRequest, jsonResponse } = require("./utils/http");
const { handleGetDietToday } = require("./handlers/http/diet");
const { createActivityFromHttp } = require("./handlers/http/activity");
const {
  createBodyFromHttp,
  getLatestBodyFromHttp,
} = require("./handlers/http/body");
const {
  exportMeals,
  createMealFromHttp,
  createAnalyzedMealFromHttp,
  getMealsToday,
  getMealsFromHttp,
  getMealFromHttp,
  updateMealFromHttp,
  deleteMealFromHttp,
} = require("./handlers/http/meals");
const { getMeals } = require("./repositories/mealsRepository");
const {
  fetchWithingsMeasures,
  parseLatestWithingsMetrics,
  parseAllWithingsMetrics,
  fetchWithingsMeasuresByRange,
  fetchWithingsActivityByDate,
  parseLatestWithingsDailyActivity,
  parseWithingsWebhookPayload,
  exchangeWithingsAuthorizationCode,
} = require("./handlers/http/withings");
const { DailySummaryIntentHandler } = require("./handlers/alexa/dailySummary");
const { getKitchenPageHtml } = require("./views/kitchenPage");
const { getSilviaPageHtml } = require("./views/silviaPage");

const {
  postKitchenDisplay,
  getKitchenCurrent,
  optionsKitchen,
} = require("./handlers/http/kitchen");

function getBuildInfo() {
  try {
    const filePath = path.join(__dirname, "build-info.json");
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return {
      packageVersion: null,
      gitCommit: null,
      gitShortCommit: null,
      gitCommitMessage: null,
      gitBranch: null,
      gitTag: null,
      gitDirty: null,
      deployedAt: null,
    };
  }
}

function getAwsRuntimeInfo() {
  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || null,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || null,
    region: process.env.AWS_REGION || null,
    executionEnv: process.env.AWS_EXECUTION_ENV || null,
    logGroupName: process.env.AWS_LAMBDA_LOG_GROUP_NAME || null,
    logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME || null,
  };
}

// Helper to robustly parse request body as JSON
function tryParseJsonBody(event) {
  if (!event?.body) {
    return {};
  }

  try {
    return JSON.parse(event.body);
  } catch (error) {
    return {};
  }
}

function getDefaultUserId() {
  return String(process.env.DEFAULT_USER_ID || "lorenzo")
    .trim()
    .toLowerCase();
}

function normalizeUserId(value) {
  return String(value || getDefaultUserId())
    .trim()
    .toLowerCase();
}

function normalizeDateString(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim().slice(0, 10);
}

function getHeaderValue(headers, name) {
  const target = String(name).toLowerCase();
  const foundKey = Object.keys(headers || {}).find(
    (key) => String(key).toLowerCase() === target,
  );

  return foundKey ? headers[foundKey] : null;
}

function getApiKeyUserMap() {
  const map = new Map();

  if (process.env.DIETA_API_KEY) {
    map.set(String(process.env.DIETA_API_KEY), getDefaultUserId());
  }

  if (process.env.API_KEY_ELISA) {
    map.set(String(process.env.API_KEY_ELISA), "elisa");
  }

  if (!process.env.API_KEY_USER_MAP) {
    return map;
  }

  try {
    const parsed = JSON.parse(process.env.API_KEY_USER_MAP);

    for (const [apiKey, userId] of Object.entries(parsed || {})) {
      if (!apiKey || !userId) {
        continue;
      }

      map.set(String(apiKey), normalizeUserId(userId));
    }
  } catch (error) {
    console.error(
      "API KEY USER MAP PARSE FAILED",
      JSON.stringify({ message: String(error?.message || error) }),
    );
  }

  return map;
}

function resolveUserIdFromApiKey(apiKey) {
  if (!apiKey) {
    return null;
  }

  return getApiKeyUserMap().get(String(apiKey)) || null;
}

// Helper to resolve the user ID from body, query params, headers, or API key.
function resolveUserId(event, body = null) {
  const parsedBody = body || tryParseJsonBody(event);
  const queryParams = event?.queryStringParameters || {};
  const headers = event?.headers || {};

  const fromBody = parsedBody?.user_id || parsedBody?.userId;
  const fromQuery = queryParams.user_id || queryParams.userId;
  const fromHeader = getHeaderValue(headers, "x-user-id");

  if (fromBody || fromQuery || fromHeader) {
    return normalizeUserId(fromBody || fromQuery || fromHeader);
  }

  const apiKey = getHeaderValue(headers, "x-api-key");
  const bearer = getHeaderValue(headers, "authorization");
  const bearerToken = String(bearer || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  return (
    resolveUserIdFromApiKey(apiKey) ||
    resolveUserIdFromApiKey(bearerToken) ||
    getDefaultUserId()
  );
}

async function invokeInternalWithingsWebhook(payload) {
  const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

  const client = new LambdaClient({
    region: process.env.AWS_REGION || "eu-west-1",
  });

  const command = new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: Buffer.from(
      JSON.stringify({
        internalType: "withings_webhook_process",
        payload,
      }),
    ),
  });

  await client.send(command);
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body,
  };
}

async function handleWithingsCallback(event) {
  const queryParams = event.queryStringParameters || {};
  const code = String(queryParams.code || "").trim();
  const error = queryParams.error || null;

  if (error) {
    console.error(
      "WITHINGS CALLBACK ERROR",
      JSON.stringify({
        error,
        errorDescription: queryParams.error_description || null,
      }),
    );

    return htmlResponse(
      400,
      `
      <html>
        <body style="font-family:sans-serif;padding:40px;">
          <h2>Withings connection failed</h2>
          <p>${String(error)}</p>
        </body>
      </html>
      `,
    );
  }

  if (!code) {
    return htmlResponse(
      400,
      `
      <html>
        <body style="font-family:sans-serif;padding:40px;">
          <h2>Missing Withings authorization code</h2>
          <p>No <code>code</code> query parameter was received.</p>
        </body>
      </html>
      `,
    );
  }

  try {
    console.log(
      "WITHINGS CALLBACK RECEIVED",
      JSON.stringify({ codeLength: code.length }),
    );

    const tokens = await exchangeWithingsAuthorizationCode(code);

    console.log(
      "WITHINGS TOKENS SAVED FROM CALLBACK",
      JSON.stringify({
        accessTokenLength: tokens.accessToken.length,
        accessTokenSuffix: tokens.accessToken.slice(-8),
        refreshTokenLength: tokens.refreshToken.length,
        refreshTokenSuffix: tokens.refreshToken.slice(-8),
        expiresIn: tokens.expiresIn || null,
      }),
    );

    return htmlResponse(
      200,
      `
      <html>
        <body style="font-family:sans-serif;padding:40px;">
          <h2>Withings connected</h2>
          <p>Tokens saved successfully. You can close this page.</p>
        </body>
      </html>
      `,
    );
  } catch (error) {
    console.error(
      "WITHINGS CALLBACK TOKEN EXCHANGE FAILED",
      JSON.stringify({ message: String(error?.message || error) }),
    );

    return htmlResponse(
      500,
      `
      <html>
        <body style="font-family:sans-serif;padding:40px;">
          <h2>Withings token exchange failed</h2>
          <p>${String(error?.message || error)}</p>
        </body>
      </html>
      `,
    );
  }
}

async function processWithingsWebhookAsync(payload) {
  // BODY MEASUREMENTS (weight, fat etc.)
  if (payload.appli === 1) {
    console.log(
      "WITHINGS WEIGHT EVENT",
      JSON.stringify({
        startdate: payload.startdate,
        enddate: payload.enddate,
      }),
    );
    if (!payload.startdate || !payload.enddate) {
      return { ok: true, ignored: true };
    }

    const raw = await fetchWithingsMeasuresByRange(
      payload.startdate,
      payload.enddate,
    );

    const measures = parseAllWithingsMetrics(raw);
    console.log("WITHINGS WEIGHT MEASURES COUNT", measures.length);

    let inserted = 0;

    for (const m of measures) {
      const measureDate = new Date(m.sourceDate * 1000);
      const date = measureDate.toISOString().slice(0, 10);
      const time = measureDate.toTimeString().slice(0, 5);

      await createBodyFromHttp(
        {
          body: JSON.stringify({
            source: "withings",
            weight: m.weight,
            body_fat: m.bodyFat ?? null,
            muscle_mass: m.muscleMass ?? null,
            water_mass: m.waterMass ?? null,
            fat_mass: m.fatMass ?? null,
            lean_mass: m.leanMass ?? null,
            raw_json: m.rawGroup,
          }),
        },
        {
          date,
          time,
          userId: normalizeUserId(process.env.WITHINGS_USER_ID),
        },
      );

      inserted++;
    }

    return {
      success: true,
      imported: inserted,
    };
  }

  // ACTIVITY (steps, distance etc.)
  if (payload.appli === 16 && payload.date) {
    console.log(
      "WITHINGS ACTIVITY EVENT",
      JSON.stringify({ date: payload.date }),
    );
    const raw = await fetchWithingsActivityByDate(payload.date);
    const activity = parseLatestWithingsDailyActivity(raw, payload.date);

    if (!activity) {
      return { ok: true, ignored: true };
    }

    await createActivityFromHttp(
      {
        body: JSON.stringify({
          source: "withings",
          activity_type: "steps",
          description: "withings daily steps",
          activity_date: activity.activityDate,
          steps: activity.steps,
          distance_km: activity.distanceKm,
          duration_min: null,
          avg_speed_kmh: null,
          calories: activity.calories,
          total_calories: activity.totalCalories,
          elevation_m: activity.elevationM,
          soft_minutes: activity.soft,
          moderate_minutes: activity.moderate,
          intense_minutes: activity.intense,
          device_model: activity.deviceModel,
          timezone: activity.timezone,
          source_id: activity.sourceId,
          source_url: activity.sourceUrl,
        }),
      },
      {
        date: activity.activityDate,
        time: "00:00",
        userId: normalizeUserId(process.env.WITHINGS_USER_ID),
      },
    );

    return {
      success: true,
      imported: 1,
    };
  }

  return { ok: true, ignored: true };
}
function getMonday(dateString) {
  const date = new Date(dateString + "T00:00:00");
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setDate(date.getDate() + diff);

  return date.toISOString().slice(0, 10);
}

async function runWeeklyStatsBackfill(userId = getDefaultUserId()) {
  console.log("WEEKLY BACKFILL START", JSON.stringify({ userId }));

  const meals = await getMeals({
    userSlug: userId,
    limit: 100000,
  });

  const uniqueDates = new Set();

  for (const meal of meals) {
    const date = normalizeDateString(meal.date);

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      uniqueDates.add(date);
    }
  }

  const uniqueWeeks = new Set();

  for (const date of uniqueDates) {
    uniqueWeeks.add(getMonday(date));
  }

  const sortedWeeks = [...uniqueWeeks].sort();

  console.log(
    "WEEKLY BACKFILL WEEKS FOUND",
    JSON.stringify({
      userId,
      count: sortedWeeks.length,
      weeks: sortedWeeks,
    }),
  );

  const results = [];

  for (const weekStart of sortedWeeks) {
    console.log(
      "WEEKLY BACKFILL PROCESSING",
      JSON.stringify({ userId, weekStart }),
    );

    const context = await getWeekDietContext(weekStart, { userId });

    const result = await upsertWeeklyStatsSnapshot({
      userSlug: userId,
      weekStart: context.week_start,
      weekEnd: context.week_end,
      intake: context.summary.intake,
      activity: context.summary.activity,
      net: context.summary.net,
      target: context.summary.target,
      remaining: context.summary.remaining,
      protein: context.summary.protein,
      carbs: context.summary.carbs,
      fat: context.summary.fat,
      recentMealsJson: context.recent_meals || [],
      foodFrequencyJson: context.food_frequency || {},
      varietyWarningsJson: context.variety_warnings || [],
      generatedAt: new Date().toISOString(),
      source: "backfill",
    });

    results.push({
      user_id: userId,
      week_start: context.week_start,
      week_end: context.week_end,
      updated: Boolean(result),
    });
  }

  console.log(
    "WEEKLY BACKFILL DONE",
    JSON.stringify({ userId, count: results.length }),
  );

  return {
    ok: true,
    user_id: userId,
    count: results.length,
    results,
  };
}

async function runDailyStatsBackfill(
  userId = getDefaultUserId(),
  options = {},
) {
  const { date: requestedDate = null, limit = null } = options;

  console.log(
    "DAILY BACKFILL START",
    JSON.stringify({ userId, requestedDate, limit }),
  );

  const meals = await getMeals({
    userSlug: userId,
    limit: 100000,
  });

  const uniqueDates = new Set();

  for (const meal of meals) {
    const date = normalizeDateString(meal.date);

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      uniqueDates.add(date);
    }
  }

  let sortedDates = [...uniqueDates].sort();

  if (requestedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return {
        ok: false,
        error: "invalid_date",
        message: "Use date format YYYY-MM-DD",
      };
    }

    sortedDates = sortedDates.includes(requestedDate) ? [requestedDate] : [];
  }

  const parsedLimit = Number(limit || 0);

  if (!requestedDate && parsedLimit > 0) {
    sortedDates = sortedDates.slice(0, parsedLimit);
  }

  console.log(
    "DAILY BACKFILL DATES FOUND",
    JSON.stringify({
      userId,
      requestedDate,
      limit: parsedLimit || null,
      count: sortedDates.length,
      dates: sortedDates,
    }),
  );

  const results = [];

  for (const date of sortedDates) {
    console.log("DAILY BACKFILL PROCESSING", JSON.stringify({ userId, date }));

    try {
      await getTodayDietReport(date, null, { userId });

      results.push({
        user_id: userId,
        date,
        updated: true,
      });
    } catch (error) {
      const message = String(error?.message || error);
      const isQuotaError =
        error?.code === 429 ||
        error?.status === 429 ||
        message.toLowerCase().includes("quota exceeded") ||
        message.toLowerCase().includes("rate limit");

      console.error(
        "DAILY BACKFILL DATE FAILED",
        JSON.stringify({
          userId,
          date,
          isQuotaError,
          message,
        }),
      );

      results.push({
        user_id: userId,
        date,
        updated: false,
        error: isQuotaError ? "quota_exceeded" : "backfill_failed",
        message,
      });

      if (isQuotaError) {
        return {
          ok: false,
          statusCode: 429,
          error: "google_sheets_quota_exceeded",
          message:
            "Google Sheets quota exceeded. Retry later or use ?date=YYYY-MM-DD for one day at a time.",
          user_id: userId,
          requested_date: requestedDate,
          limit: parsedLimit || null,
          count: results.filter((item) => item.updated).length,
          results,
        };
      }
    }
  }

  console.log(
    "DAILY BACKFILL DONE",
    JSON.stringify({ userId, count: results.length }),
  );

  return {
    ok: true,
    user_id: userId,
    requested_date: requestedDate,
    limit: parsedLimit || null,
    count: results.length,
    results,
  };
}

function optionsSilvia() {
  return {
    statusCode: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: "",
  };
}

function buildDefaultSilviaMealPayload() {
  return {
    title: "Nessuna porzione inviata",
    servings: "1 porzione",
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    ingredients: [],
  };
}

function mapSilviaMealStateRow(row) {
  if (!row) {
    return {
      updatedAt: null,
      payload: buildDefaultSilviaMealPayload(),
    };
  }

  return {
    updatedAt: row.updated_at || null,
    payload: row.payload || buildDefaultSilviaMealPayload(),
  };
}

async function getSilviaMealState() {
  const result = await query(
    `
    SELECT payload, updated_at
    FROM app_state
    WHERE state_key = $1
    LIMIT 1
    `,
    ["silvia_meal"],
  );

  return mapSilviaMealStateRow(result.rows[0]);
}

async function saveSilviaMealState(payload) {
  const result = await query(
    `
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (state_key)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING payload, updated_at
    `,
    ["silvia_meal", JSON.stringify(payload)],
  );

  return mapSilviaMealStateRow(result.rows[0]);
}

async function getSilviaCurrent() {
  const state = await getSilviaMealState();

  return jsonResponse(200, {
    ok: true,
    updatedAt: state.updatedAt,
    payload: state.payload,
  });
}

function normalizeSilviaIngredient(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const name = item.name || item.description || item.title || "Ingrediente";
    const grams =
      item.grams ?? item.g ?? item.quantity_g ?? item.quantityGrams ?? null;
    const calories = item.calories ?? item.kcal ?? null;

    return {
      name: String(name).trim(),
      grams:
        grams === null || grams === undefined || grams === ""
          ? null
          : Number(grams),
      calories:
        calories === null || calories === undefined || calories === ""
          ? null
          : Number(calories),
    };
  }

  return {
    name: String(item || "").trim(),
    grams: null,
    calories: null,
  };
}

function normalizeSilviaDisplayPayload(payload) {
  const ingredients = Array.isArray(payload.ingredients)
    ? payload.ingredients
        .map(normalizeSilviaIngredient)
        .filter((item) => item.name)
    : [];

  return {
    title: String(payload.title || "Porzione Silvia").trim(),
    servings: String(payload.servings || "1 porzione").trim(),
    calories: Number(payload.calories || 0),
    protein: Number(payload.protein || 0),
    carbs: Number(payload.carbs || 0),
    fat: Number(payload.fat || 0),
    ingredients,
  };
}

async function postSilviaDisplay(event) {
  let payload;

  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_json",
    });
  }

  const normalizedPayload = normalizeSilviaDisplayPayload(payload);
  const result = await saveSilviaMealState(normalizedPayload);

  return jsonResponse(200, {
    ok: true,
    updatedAt: result.updatedAt,
    payload: normalizedPayload,
  });
}

function buildMealHandler(intentName, mealType) {
  return {
    canHandle(handlerInput) {
      return (
        Alexa.getRequestType(handlerInput.requestEnvelope) ===
          "IntentRequest" &&
        Alexa.getIntentName(handlerInput.requestEnvelope) === intentName
      );
    },
    async handle(handlerInput) {
      let mealText =
        handlerInput.requestEnvelope.request.intent.slots?.meal?.value?.trim();

      if (!mealText) {
        const missingSpeech =
          mealType === "attivita"
            ? "Non ho capito il contenuto dell'attività. Ripeti includendo quantità o durata."
            : `Non ho capito il contenuto della ${mealType}. Ripeti includendo quantità e alimenti.`;

        const missingReprompt =
          mealType === "attivita"
            ? "Per esempio: attività 6900 passi oppure attività camminata 40 minuti."
            : `Per esempio: ${mealType} 170 grammi di yogurt greco e una banana.`;

        return handlerInput.responseBuilder
          .speak(missingSpeech)
          .reprompt(missingReprompt)
          .getResponse();
      }

      mealText = normalizeNumbers(mealText);

      try {
        const analysis = await analyzeMeal(mealType, mealText);
        const { date, time } = getDateTimeParts(TIMEZONE);

        if (mealType === "attivita") {
          const activityPayload = {
            source: "alexa",
            activity_type: analysis.activity_type || "manual",
            description:
              analysis.description_normalized ||
              analysis.description ||
              mealText,
            activity_date: date,
            calories: Number(analysis.total?.calories || 0),
            distance_km: Number(analysis.total?.distance_km || 0) || null,
            duration_min: Number(analysis.total?.duration_min || 0) || null,
            steps: Number(analysis.total?.steps || 0) || null,
            avg_speed_kmh: Number(analysis.total?.avg_speed_kmh || 0) || null,
            source_id: null,
            source_url: null,
          };

          const alexaUserId = getDefaultUserId();

          await createActivityFromHttp(
            { body: JSON.stringify(activityPayload) },
            { date, time, userId: alexaUserId },
          );

          const activityReport = await getTodayDietReport(date, null, {
            userId: alexaUserId,
          });
          const activityRemaining = Number(
            activityReport?.summary?.remaining ?? 0,
          );

          let activityRemainingSpeech;

          if (activityRemaining > 0) {
            activityRemainingSpeech = ` Ti restano circa ${Math.round(activityRemaining)} calorie oggi.`;
          } else {
            activityRemainingSpeech = ` Hai superato il target di circa ${Math.abs(Math.round(activityRemaining))} calorie.`;
          }

          let speechText =
            "Ho registrato l'attività. " +
            `${Number(analysis.total?.calories || 0)} calorie.` +
            activityRemainingSpeech;

          if (analysis.missing_quantities) {
            speechText +=
              " Attenzione: mancavano alcuni dettagli, quindi il calcolo è più approssimativo.";
          }

          return handlerInput.responseBuilder
            .speak(speechText)
            .reprompt(
              "Puoi registrare un altro pasto oppure chiedermi il riepilogo di oggi.",
            )
            .getResponse();
        }

        const alexaUserId = getDefaultUserId();

        await createMealFromHttp(
          {
            body: JSON.stringify({
              meal_type: analysis.meal_type || mealType,
              description: analysis.description_normalized || mealText,
              calories: Number(analysis.total.calories || 0),
              protein: Number(analysis.total.protein || 0),
              carbs: Number(analysis.total.carbs || 0),
              fat: Number(analysis.total.fat || 0),
              source: "alexa",
            }),
          },
          { date, time, userId: alexaUserId },
        );

        const mealReport = await getTodayDietReport(date, null, {
          userId: alexaUserId,
        });
        const remaining = Number(mealReport?.summary?.remaining ?? 0);

        let remainingSpeech;

        if (remaining > 0) {
          remainingSpeech = `Ti restano circa ${Math.round(remaining)} calorie oggi.`;
        } else {
          remainingSpeech = `Hai superato il target di circa ${Math.abs(Math.round(remaining))} calorie.`;
        }

        let speechText =
          `Ho registrato la ${mealType}. ` +
          `${Number(analysis.total.calories || 0)} calorie. ` +
          remainingSpeech;

        if (analysis.missing_quantities) {
          speechText +=
            " Attenzione: per almeno un alimento mancava una quantità chiara, quindi il calcolo è più approssimativo.";
        }

        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt(
            "Puoi registrare un altro pasto oppure chiedermi il riepilogo di oggi.",
          )
          .getResponse();
      } catch (error) {
        console.error(`Errore ${intentName}:`, error);

        let speechText =
          mealType === "attivita"
            ? "C'è stato un problema nel registrare l'attività."
            : "C'è stato un problema nel registrare il pasto.";

        if (String(error.message).includes("insufficient_quota")) {
          speechText =
            "La connessione a OpenAI funziona, ma il credito API disponibile è terminato.";
        }

        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt("Riprova con quantità o dettagli più chiari.")
          .getResponse();
      }
    },
  };
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("Ciao, sono Alambicco.")
      .reprompt(
        "Prova a dire: pranzo 80 grammi di riso basmati e 120 grammi di tonno. Oppure: attività camminata 40 minuti.",
      )
      .getResponse();
  },
};

const AskChatGPTIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "AskChatGPTIntent"
    );
  },
  async handle(handlerInput) {
    let question =
      handlerInput.requestEnvelope.request.intent.slots?.question?.value?.trim();

    if (!question) {
      return handlerInput.responseBuilder
        .speak("Non ho capito la domanda. Prova a ripeterla.")
        .reprompt("Dimmi pure la tua domanda.")
        .getResponse();
    }

    const sessionAttributes =
      handlerInput.attributesManager.getSessionAttributes();
    const history = sessionAttributes.history || [];

    question = question
      .replace(/^a alambicco ai\s+/i, "")
      .replace(/^ad alambicco ai\s+/i, "")
      .trim();

    try {
      const answer = await askChat(question, history);

      const newHistory = [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ].slice(-6);

      sessionAttributes.history = newHistory;
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);

      return handlerInput.responseBuilder
        .speak(answer)
        .reprompt("Puoi continuare, oppure chiedermi il riepilogo di oggi.")
        .getResponse();
    } catch (error) {
      console.error("Errore AskChatGPTIntent:", error);

      let speechText = "C'è stato un problema nel recuperare la risposta.";

      if (String(error.message).includes("insufficient_quota")) {
        speechText =
          "La connessione a OpenAI è configurata, ma il credito API disponibile è terminato.";
      }

      return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt("Puoi riprovare con una domanda più breve.")
        .getResponse();
    }
  },
};

const FollowUpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "FollowUpIntent"
    );
  },
  async handle(handlerInput) {
    const sessionAttributes =
      handlerInput.attributesManager.getSessionAttributes();
    const history = sessionAttributes.history || [];

    if (history.length === 0) {
      return handlerInput.responseBuilder
        .speak("Non ho ancora un contesto. Fai prima una domanda completa.")
        .reprompt("Per esempio, puoi dire: spiegami i buchi neri.")
        .getResponse();
    }

    const followUpPrompt =
      "Approfondisci la risposta precedente in modo chiaro, breve e parlato.";

    try {
      const answer = await askChat(followUpPrompt, history);

      const newHistory = [
        ...history,
        { role: "user", content: followUpPrompt },
        { role: "assistant", content: answer },
      ].slice(-6);

      sessionAttributes.history = newHistory;
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);

      return handlerInput.responseBuilder
        .speak(answer)
        .reprompt("Puoi farmi un'altra domanda o chiedermi un esempio.")
        .getResponse();
    } catch (error) {
      console.error("Errore FollowUpIntent:", error);

      return handlerInput.responseBuilder
        .speak("C'è stato un problema nel continuare la conversazione.")
        .reprompt("Puoi riprovare.")
        .getResponse();
    }
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "AMAZON.HelpIntent"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Puoi farmi una domanda, registrare un pasto oppure registrare un'attività. Per esempio: pranzo 80 grammi di riso basmati e 120 grammi di tonno. Oppure: attività 6900 passi. Puoi anche chiedere: riepilogo oggi.",
      )
      .reprompt("Prova a dirmi cosa hai mangiato.")
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      (Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "AMAZON.CancelIntent" ||
        Alexa.getIntentName(handlerInput.requestEnvelope) ===
          "AMAZON.StopIntent")
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak("A presto.").getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "AMAZON.FallbackIntent"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Non ho capito. Puoi farmi una domanda, dire un pasto con quantità, oppure registrare un'attività, per esempio: attività 6900 passi.",
      )
      .reprompt("Riprova con una frase più chiara.")
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) ===
      "SessionEndedRequest"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error("Errore generale skill:", error);

    return handlerInput.responseBuilder
      .speak("Si è verificato un errore.")
      .reprompt("Riprova tra poco.")
      .getResponse();
  },
};

async function httpHandler(event) {
  const path = event.rawPath || event.path || "/";
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";
  const requestBody = tryParseJsonBody(event);
  const userId = resolveUserId(event, requestBody);

  if (path.includes("/withings/callback") && method === "GET") {
    return handleWithingsCallback(event);
  }

  // Withings webhook (no auth)
  if (path.includes("/withings/webhook") && method === "POST") {
    console.log(
      "WITHINGS WEBHOOK RECEIVED",
      JSON.stringify({ path, method, hasBody: !!event.body }),
    );
    // Withings may send a validation POST with empty or non-JSON body.
    if (!event.body) {
      return jsonResponse(200, { ok: true, validation: true });
    }
    let payload;
    try {
      payload = parseWithingsWebhookPayload(event);

      if (!payload) {
        console.log(
          "WITHINGS PAYLOAD PARSE FAILED",
          "empty_or_invalid_payload",
        );
        return jsonResponse(200, { ok: true, ignored: true });
      }

      console.log("WITHINGS PAYLOAD", JSON.stringify(payload));
    } catch (error) {
      console.log(
        "WITHINGS PAYLOAD PARSE FAILED",
        String(error?.message || error),
      );
      return jsonResponse(200, { ok: true, ignored: true });
    }

    try {
      await invokeInternalWithingsWebhook(payload);
      console.log(
        "WITHINGS WEBHOOK ENQUEUED",
        JSON.stringify({ appli: payload.appli, date: payload.date ?? null }),
      );
      return jsonResponse(200, { ok: true, queued: true });
    } catch (error) {
      console.error(
        "WITHINGS WEBHOOK ENQUEUE FAILED",
        JSON.stringify({
          message: String(error?.message || error),
          appli: payload?.appli ?? null,
          date: payload?.date ?? null,
        }),
      );
      return jsonResponse(500, {
        ok: false,
        error: "withings_webhook_enqueue_failed",
      });
    }
  }

  const isPublicDisplayGet =
    (path.includes("/kitchen") && method === "GET") ||
    (path.includes("/kitchen") && method === "OPTIONS") ||
    (path.includes("/kitchen/current") && method === "GET") ||
    (path.includes("/kitchen/current") && method === "OPTIONS") ||
    (path.includes("/silvia") && method === "GET") ||
    (path.includes("/silvia") && method === "OPTIONS") ||
    (path.includes("/silvia/current") && method === "GET") ||
    (path.includes("/silvia/current") && method === "OPTIONS");

  // Protect all HTTP routes except the Withings webhook, Withings callback, and public display reads
  if (
    !path.includes("/withings/webhook") &&
    !path.includes("/withings/callback") &&
    !isPublicDisplayGet &&
    !authorizeHttpRequest(event)
  ) {
    return jsonResponse(401, { error: "Unauthorized" });
  }
  if (
    path.includes("/kitchen") &&
    !path.includes("/kitchen/current") &&
    !path.includes("/kitchen/display") &&
    method === "OPTIONS"
  ) {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,x-api-key",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: "",
    };
  }
  if (
    path.includes("/kitchen") &&
    !path.includes("/kitchen/current") &&
    !path.includes("/kitchen/display") &&
    method === "GET"
  ) {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,x-api-key",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: getKitchenPageHtml(),
    };
  }
  if (path.includes("/version") && method === "GET") {
    return jsonResponse(200, {
      ok: true,
      service: "dieta-api",
      version: getBuildInfo(),
      aws: getAwsRuntimeInfo(),
    });
  }
  if (path.includes("/kitchen/display") && method === "OPTIONS") {
    return optionsKitchen();
  }

  if (path.includes("/kitchen/current") && method === "OPTIONS") {
    return optionsKitchen();
  }

  if (path.includes("/kitchen/display") && method === "POST") {
    return postKitchenDisplay(event);
  }

  if (path.includes("/kitchen/current") && method === "GET") {
    return getKitchenCurrent();
  }

  if (
    path.includes("/silvia") &&
    !path.includes("/silvia/current") &&
    !path.includes("/silvia/display") &&
    method === "OPTIONS"
  ) {
    return optionsSilvia();
  }

  if (
    path.includes("/silvia") &&
    !path.includes("/silvia/current") &&
    !path.includes("/silvia/display") &&
    method === "GET"
  ) {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,x-api-key",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: getSilviaPageHtml(),
    };
  }

  if (path.includes("/silvia/display") && method === "OPTIONS") {
    return optionsSilvia();
  }

  if (path.includes("/silvia/current") && method === "OPTIONS") {
    return optionsSilvia();
  }

  if (path.includes("/silvia/display") && method === "POST") {
    return postSilviaDisplay(event);
  }

  if (path.includes("/silvia/current") && method === "GET") {
    return getSilviaCurrent();
  }

  if (path.includes("/withings/import-all") && method === "GET") {
    const raw = await fetchWithingsMeasures();
    const measures = parseAllWithingsMetrics(raw);

    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - 2);

    const recentMeasures = measures.filter((m) => {
      const measureDate = new Date(m.sourceDate * 1000);
      return measureDate >= cutoff;
    });

    let inserted = 0;

    for (const m of recentMeasures) {
      const measureDate = new Date(m.sourceDate * 1000);
      const date = measureDate.toISOString().slice(0, 10);
      const time = measureDate.toTimeString().slice(0, 5);

      await createBodyFromHttp(
        {
          body: JSON.stringify({
            source: "withings",
            weight: m.weight,
            body_fat: m.bodyFat ?? null,
            muscle_mass: m.muscleMass ?? null,
            water_mass: m.waterMass ?? null,
            fat_mass: m.fatMass ?? null,
            lean_mass: m.leanMass ?? null,
            raw_json: m.rawGroup,
          }),
        },
        {
          date,
          time,
          userId: normalizeUserId(process.env.WITHINGS_USER_ID),
        },
      );

      inserted++;
    }
    return jsonResponse(200, {
      success: true,
      imported: inserted,
      cutoff: cutoff.toISOString().slice(0, 10),
    });
  }

  if (path.includes("/activity") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createActivityFromHttp(event, { date, time, userId });
  }

  if (path.includes("/body/latest") && method === "GET") {
    return getLatestBodyFromHttp({ userId });
  }

  if (path.includes("/body") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createBodyFromHttp(event, { date, time, userId });
  }

  if (path.includes("/meals/today") && method === "GET") {
    const { date } = getDateTimeParts(TIMEZONE);
    return getMealsToday({ date, userId });
  }

  if (path.includes("/meals/analyze") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createAnalyzedMealFromHttp(event, { date, time, userId });
  }
  if (path.includes("/admin/backfill-weekly-stats") && method === "POST") {
    const result = await runWeeklyStatsBackfill(userId);

    return jsonResponse(200, result);
  }
  if (path.includes("/admin/backfill-daily-stats") && method === "POST") {
    const queryParams = event.queryStringParameters || {};
    const result = await runDailyStatsBackfill(userId, {
      date: queryParams.date || null,
      limit: queryParams.limit || null,
    });

    return jsonResponse(
      result.statusCode || (result.ok === false ? 400 : 200),
      result,
    );
  }
  if (path.includes("/diet/week-context") && method === "GET") {
    const { date: today } = getDateTimeParts(TIMEZONE);

    const queryParams = event.queryStringParameters || {};
    const referenceDate = queryParams.date || today;

    const context = await getWeekDietContext(referenceDate, { userId });

    try {
      await upsertWeeklyStatsSnapshot({
        userSlug: userId,
        weekStart: context.week_start,
        weekEnd: context.week_end,
        intake: context.summary.intake,
        activity: context.summary.activity,
        net: context.summary.net,
        target: context.summary.target,
        remaining: context.summary.remaining,
        protein: context.summary.protein,
        carbs: context.summary.carbs,
        fat: context.summary.fat,
        recentMealsJson: context.recent_meals || [],
        foodFrequencyJson: context.food_frequency || {},
        varietyWarningsJson: context.variety_warnings || [],
        generatedAt: new Date().toISOString(),
        source: "refresh",
      });
    } catch (error) {
      console.error(
        "WEEKLY STATS REFRESH FAILED",
        JSON.stringify({
          userId,
          referenceDate,
          weekStart: context.week_start,
          message: String(error?.message || error),
        }),
      );
    }

    return jsonResponse(200, {
      ok: true,
      context,
    });
  }
  if (path.includes("/diet/today") && method === "GET") {
    const { date } = getDateTimeParts(TIMEZONE);
    return handleGetDietToday({ date, userId });
  }

  if (/\/meals\/[^/]+$/.test(path) && method === "GET") {
    return getMealFromHttp(event, { userId });
  }

  if (/\/meals\/[^/]+$/.test(path) && method === "PATCH") {
    return updateMealFromHttp(event, { userId });
  }

  if (/\/meals\/[^/]+$/.test(path) && method === "DELETE") {
    return deleteMealFromHttp(event, { userId });
  }

  if (path.includes("/meals") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createMealFromHttp(event, { date, time, userId });
  }

  if (path.includes("/meals") && method === "GET") {
    return getMealsFromHttp(event, { userId });
  }

  if (path.includes("/withings/latest") && method === "GET") {
    const raw = await fetchWithingsMeasures();
    const latest = parseLatestWithingsMetrics(raw);

    if (!latest) {
      return jsonResponse(404, {
        error: "Nessuna misura valida trovata in Withings",
      });
    }

    const measureDate = new Date(latest.sourceDate * 1000);

    const date = measureDate.toISOString().slice(0, 10);
    const time = measureDate.toTimeString().slice(0, 5);

    const withingsUserId = normalizeUserId(process.env.WITHINGS_USER_ID);

    await createBodyFromHttp(
      {
        body: JSON.stringify({
          source: "withings",
          weight: latest.weight,
          body_fat: latest.bodyFat ?? null,
          muscle_mass: latest.muscleMass ?? null,
          water_mass: latest.waterMass ?? null,
          fat_mass: latest.fatMass ?? null,
          lean_mass: latest.leanMass ?? null,
          raw_json: latest.rawGroup,
        }),
      },
      {
        date,
        time,
        userId: withingsUserId,
      },
    );

    return jsonResponse(200, {
      success: true,
      saved: {
        user_id: withingsUserId,
        date,
        time,
        source: "withings",
        weight: latest.weight,
        body_fat: latest.bodyFat,
        muscle_mass: latest.muscleMass,
        water_mass: latest.waterMass,
        fat_mass: latest.fatMass,
        lean_mass: latest.leanMass,
      },
    });
  }

  return jsonResponse(404, { error: "Not found", path, method });
}

const LogBreakfastIntentHandler = buildMealHandler(
  "LogBreakfastIntent",
  "colazione",
);
const LogLunchIntentHandler = buildMealHandler("LogLunchIntent", "pranzo");
const LogDinnerIntentHandler = buildMealHandler("LogDinnerIntent", "cena");
const LogSnackIntentHandler = buildMealHandler("LogSnackIntent", "spuntino");
const LogActivityIntentHandler = buildMealHandler(
  "LogActivityIntent",
  "attivita",
);

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    AskChatGPTIntentHandler,
    FollowUpIntentHandler,
    LogBreakfastIntentHandler,
    LogLunchIntentHandler,
    LogDinnerIntentHandler,
    LogSnackIntentHandler,
    LogActivityIntentHandler,
    DailySummaryIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .create();

exports.handler = async (event, context) => {
  if (event?.internalType === "keep_warm") {
    console.log(
      "KEEP WARM INVOCATION",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || null,
        functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || null,
      }),
    );

    return {
      ok: true,
      keepWarm: true,
      timestamp: new Date().toISOString(),
    };
  }

  if (event?.internalType === "withings_webhook_process") {
    console.log(
      "WITHINGS INTERNAL PROCESS START",
      JSON.stringify({
        appli: event?.payload?.appli ?? null,
        date: event?.payload?.date ?? null,
      }),
    );

    try {
      const result = await processWithingsWebhookAsync(event.payload || {});
      console.log(
        "WITHINGS INTERNAL PROCESS DONE",
        JSON.stringify(result || {}),
      );
      return result;
    } catch (error) {
      console.error(
        "WITHINGS INTERNAL PROCESS FAILED",
        JSON.stringify({
          message: String(error?.message || error),
          stack: error?.stack || null,
        }),
      );
      throw error;
    }
  }

  if (event?.requestContext?.http) {
    return httpHandler(event);
  }

  return skill.invoke(event, context);
};
