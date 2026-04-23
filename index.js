const fs = require("fs");
const path = require("path");
const Alexa = require("ask-sdk-core");
const { askChat, analyzeMeal } = require("./openai");
const {
  appendMealRow,
  appendBodyRow,
  getLastBodyRow,
  getTodayDietReport,
} = require("./sheets");
const { getDateTimeParts } = require("./utils");
const { normalizeNumbers } = require("./numberNormalizer");
const { TIMEZONE, DAILY_TARGET } = require("./config");
const { authorizeHttpRequest, jsonResponse } = require("./utils/http");
const { handleGetDietToday } = require("./handlers/http/diet");
const { createActivityFromHttp } = require("./handlers/http/activity");
const {
  exportMeals,
  createMealFromHttp,
  createAnalyzedMealFromHttp,
  getMealsToday,
} = require("./handlers/http/meals");
const {
  fetchWithingsMeasures,
  parseLatestWithingsMetrics,
  parseAllWithingsMetrics,
  fetchWithingsMeasuresByRange,
  fetchWithingsActivityByDate,
  parseLatestWithingsDailyActivity,
  parseWithingsWebhookPayload,
} = require("./handlers/http/withings");
const { DailySummaryIntentHandler } = require("./handlers/alexa/dailySummary");

const {
  postKitchenDisplay,
  getKitchenCurrent,
  optionsKitchen,
} = require("./handlers/http/kitchen");

function getKitchenPageHtml() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cucina</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #111;
      color: #fff;
      padding: 24px;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
    }

    h1 {
      font-size: 42px;
      margin-bottom: 12px;
    }

    .meta {
      font-size: 20px;
      color: #ccc;
      margin-bottom: 24px;
    }

    h2 {
      font-size: 28px;
      margin-top: 32px;
      margin-bottom: 12px;
      border-bottom: 1px solid #333;
      padding-bottom: 8px;
    }

    ul, ol {
      font-size: 24px;
      line-height: 1.6;
      padding-left: 28px;
    }

    li {
      margin-bottom: 10px;
    }

    .notes {
      margin-top: 24px;
      font-size: 22px;
      color: #ddd;
      background: #1b1b1b;
      padding: 16px;
      border-radius: 12px;
    }

    .empty {
      font-size: 28px;
      color: #bbb;
      text-align: center;
      margin-top: 120px;
    }

    .updated {
      margin-top: 24px;
      font-size: 16px;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    <div class="empty">Nessuna ricetta inviata alla cucina.</div>
  </div>

  <script>
    const API_URL = "/kitchen/current";

    async function loadKitchen() {
      try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const state = data?.state;
        const recipe = state?.recipe;
        const app = document.getElementById("app");

        if (!recipe) {
          app.innerHTML = '<div class="empty">Nessuna ricetta inviata alla cucina.</div>';
          return;
        }

        app.innerHTML = \`
          <h1>\${escapeHtml(recipe.title || "")}</h1>
          <div class="meta">Porzioni: \${recipe.servings ?? "-"}</div>

          <h2>Ingredienti</h2>
          <ul>
            \${(recipe.ingredients || []).map(item => \`<li>\${escapeHtml(item)}</li>\`).join("")}
          </ul>

          <h2>Procedimento</h2>
          <ol>
            \${(recipe.steps || []).map(step => \`<li>\${escapeHtml(step)}</li>\`).join("")}
          </ol>

          \${recipe.notes ? \`<div class="notes">\${escapeHtml(recipe.notes)}</div>\` : ""}

          <div class="updated">
            Ultimo aggiornamento: \${state.updatedAt ? new Date(state.updatedAt).toLocaleString("it-IT") : "-"}
          </div>
        \`;
      } catch (error) {
        document.getElementById("app").innerHTML =
          '<div class="empty">Errore nel caricamento della ricetta.</div>';
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    loadKitchen();
    setInterval(loadKitchen, 5000);
  </script>
</body>
</html>`;
}

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

      await appendBodyRow([
        date,
        time,
        "withings",
        m.weight,
        m.bodyFat ?? "",
        m.muscleMass ?? "",
        m.waterMass ?? "",
        m.fatMass ?? "",
        m.leanMass ?? "",
        JSON.stringify(m.rawGroup),
      ]);

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
      { date: activity.activityDate, time: "00:00" },
    );

    return {
      success: true,
      imported: 1,
    };
  }

  return { ok: true, ignored: true };
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

          await createActivityFromHttp(
            { body: JSON.stringify(activityPayload) },
            { date, time },
          );

          const activityReport = await getTodayDietReport(date, DAILY_TARGET);
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

        await appendMealRow([
          date,
          time,
          analysis.meal_type || mealType,
          analysis.description_normalized || mealText,
          Number(analysis.total.calories || 0),
          Number(analysis.total.protein || 0),
          Number(analysis.total.carbs || 0),
          Number(analysis.total.fat || 0),
        ]);

        const mealReport = await getTodayDietReport(date, DAILY_TARGET);
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

  const isPublicKitchenGet =
    (path.includes("/kitchen") && method === "GET") ||
    (path.includes("/kitchen") && method === "OPTIONS") ||
    (path.includes("/kitchen/current") && method === "GET") ||
    (path.includes("/kitchen/current") && method === "OPTIONS");

  // Protect all HTTP routes except the Withings webhook and public kitchen display reads
  if (
    !path.includes("/withings/webhook") &&
    !isPublicKitchenGet &&
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

      await appendBodyRow([
        date,
        time,
        "withings",
        m.weight,
        m.bodyFat ?? "",
        m.muscleMass ?? "",
        m.waterMass ?? "",
        m.fatMass ?? "",
        m.leanMass ?? "",
        JSON.stringify(m.rawGroup),
      ]);

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
    return createActivityFromHttp(event, { date, time });
  }

  if (path.includes("/meals/today") && method === "GET") {
    const { date } = getDateTimeParts(TIMEZONE);
    return getMealsToday({ date });
  }

  if (path.includes("/meals/analyze") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createAnalyzedMealFromHttp(event, { date, time });
  }

  if (path.includes("/diet/today") && method === "GET") {
    const { date } = getDateTimeParts(TIMEZONE);
    return handleGetDietToday({ date });
  }

  if (path.includes("/meals") && method === "POST") {
    const { date, time } = getDateTimeParts(TIMEZONE);
    return createMealFromHttp(event, { date, time });
  }

  if (path.includes("/meals") && method === "GET") {
    return exportMeals();
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

    const last = await getLastBodyRow();

    if (last && String(last.sourceDate) === String(latest.sourceDate)) {
      return jsonResponse(200, {
        success: true,
        skipped: true,
        reason: "duplicate_measure",
        weight: latest.weight,
        body_fat: latest.bodyFat,
        muscle_mass: latest.muscleMass,
        water_mass: latest.waterMass,
        fat_mass: latest.fatMass,
        lean_mass: latest.leanMass,
      });
    }

    await appendBodyRow([
      date,
      time,
      "withings",
      latest.weight,
      latest.bodyFat ?? "",
      latest.muscleMass ?? "",
      latest.waterMass ?? "",
      latest.fatMass ?? "",
      latest.leanMass ?? "",
      JSON.stringify(latest.rawGroup),
    ]);

    return jsonResponse(200, {
      success: true,
      saved: {
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
