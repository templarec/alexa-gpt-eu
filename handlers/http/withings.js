const { query } = require("../../db/postgres");

function cleanValue(value) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned.length ? cleaned : null;
}

async function getConfigValue(key) {
  const result = await query(
    `
    SELECT payload
    FROM app_state
    WHERE state_key IN ($1, $2)
    ORDER BY
      CASE
        WHEN state_key = $1 THEN 0
        ELSE 1
      END
    LIMIT 1
    `,
    [`config:${key}`, key],
  );

  const payload = result.rows[0]?.payload;

  if (payload == null) {
    return null;
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (
    typeof payload === "object" &&
    Object.prototype.hasOwnProperty.call(payload, "value")
  ) {
    return payload.value;
  }

  return String(payload);
}

async function setConfigValue(key, value) {
  await query(
    `
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (state_key)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
    `,
    [`config:${key}`, JSON.stringify(value)],
  );
}

const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

function getWithingsRedirectUri() {
  return (
    cleanValue(process.env.WITHINGS_REDIRECT_URI) ||
    "https://fqyircpk2e.execute-api.eu-west-1.amazonaws.com/withings/callback"
  );
}

async function exchangeWithingsAuthorizationCode(code) {
  const clientId = cleanValue(process.env.WITHINGS_CLIENT_ID);
  const clientSecret = cleanValue(process.env.WITHINGS_CLIENT_SECRET);
  const redirectUri = getWithingsRedirectUri();

  if (!clientId || !clientSecret) {
    throw new Error("Missing WITHINGS_CLIENT_ID or WITHINGS_CLIENT_SECRET");
  }

  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  console.log(
    "WITHINGS AUTHORIZATION CODE EXCHANGE REQUEST",
    JSON.stringify({
      redirectUri,
      codeLength: code?.length || 0,
    }),
  );

  const response = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  console.log(
    "WITHINGS AUTHORIZATION CODE EXCHANGE RESPONSE",
    JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status ?? null,
      hasAccessToken: !!data?.body?.access_token,
      hasRefreshToken: !!data?.body?.refresh_token,
      error: data?.error ?? null,
      errors: data?.errors ?? null,
    }),
  );

  if (!response.ok || data?.status !== 0 || !data?.body?.access_token) {
    throw new Error(
      `Withings authorization code exchange failed: HTTP ${response.status} / apiStatus ${data?.status ?? "null"} / raw ${rawText}`,
    );
  }

  const accessToken = cleanValue(data.body.access_token);
  const refreshToken = cleanValue(data.body.refresh_token);
  const expiresIn = data.body?.expires_in ?? null;

  if (!accessToken || !refreshToken) {
    throw new Error(`Withings token response missing tokens: ${rawText}`);
  }

  await saveWithingsTokens({
    accessToken,
    refreshToken,
    expiresIn,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn,
  };
}

async function saveWithingsTokens({
  accessToken,
  refreshToken,
  expiresIn = null,
}) {
  await setConfigValue("withings_access_token", {
    value: accessToken,
  });

  await setConfigValue("withings_refresh_token", {
    value: refreshToken,
  });

  await setConfigValue("withings_token_expires_in", {
    value: expiresIn,
  });

  process.env.WITHINGS_ACCESS_TOKEN = accessToken;
  process.env.WITHINGS_REFRESH_TOKEN = refreshToken;

  console.log(
    "WITHINGS TOKENS SAVED",
    JSON.stringify({
      accessTokenLength: accessToken?.length || 0,
      refreshTokenLength: refreshToken?.length || 0,
      refreshTokenSuffix: refreshToken?.slice(-8) || null,
      expiresIn,
    }),
  );
}

async function refreshWithingsAccessToken() {
  const clientId = cleanValue(process.env.WITHINGS_CLIENT_ID);
  const clientSecret = cleanValue(process.env.WITHINGS_CLIENT_SECRET);

  const storedRefreshToken = cleanValue(
    await getConfigValue("withings_refresh_token"),
  );
  const envRefreshToken = cleanValue(process.env.WITHINGS_REFRESH_TOKEN);
  const refreshToken = storedRefreshToken || envRefreshToken;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Credenziali Withings mancanti per refresh token");
  }

  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  console.log(
    "WITHINGS REFRESH TOKEN REQUEST",
    JSON.stringify({
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken,
      refreshTokenLength: refreshToken.length,
      refreshTokenSuffix: refreshToken.slice(-8),
      refreshTokenSource: storedRefreshToken ? "config" : "env",
    }),
  );

  const response = await fetch("https://wbsapi.withings.net/v2/oauth2", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  console.log(
    "WITHINGS REFRESH TOKEN RESPONSE",
    JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status ?? null,
      hasAccessToken: !!data?.body?.access_token,
      hasRefreshToken: !!data?.body?.refresh_token,
      error: data?.error ?? null,
      errors: data?.errors ?? null,
      rawText,
    }),
  );

  if (!response.ok || data?.status !== 0 || !data?.body?.access_token) {
    throw new Error(
      `Refresh token Withings fallito: HTTP ${response.status} / apiStatus ${data?.status ?? "null"} / raw ${rawText}`,
    );
  }

  const newAccessToken = cleanValue(data.body.access_token);
  const newRefreshToken = cleanValue(data.body.refresh_token) || refreshToken;
  const expiresIn = data.body?.expires_in ?? null;

  await saveWithingsTokens({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn,
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
}

async function fetchWithingsMeasures() {
  let token =
    cleanValue(await getConfigValue("withings_access_token")) ||
    cleanValue(process.env.WITHINGS_ACCESS_TOKEN);

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  const url = "https://wbsapi.withings.net/measure?action=getmeas";

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  let data = await response.json();

  console.log(
    "WITHINGS MEASURES RESPONSE",
    JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      measureGroups: data?.body?.measuregrps?.length || 0,
    }),
  );

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    data = await response.json();

    console.log(
      "WITHINGS MEASURES RESPONSE RETRY",
      JSON.stringify({
        httpStatus: response.status,
        apiStatus: data?.status,
        measureGroups: data?.body?.measuregrps?.length || 0,
      }),
    );
  }

  if (!response.ok) {
    throw new Error(`Errore Withings HTTP ${response.status}`);
  }

  if (data.status !== 0) {
    throw new Error(`Errore Withings API status ${data.status}`);
  }

  return data;
}

function parseLatestWithingsMetrics(data) {
  const groups = data?.body?.measuregrps || [];

  for (const group of groups) {
    let weight = null;
    let bodyFat = null;
    let muscleMass = null;
    let waterMass = null;
    let fatMass = null;
    let leanMass = null;

    for (const measure of group.measures || []) {
      const value = measure.value * Math.pow(10, measure.unit);

      if (measure.type === 1) weight = value;
      if (measure.type === 6) bodyFat = value;
      if (measure.type === 5) muscleMass = value;
      if (measure.type === 76) waterMass = value;
      if (measure.type === 4) fatMass = value;
      if (measure.type === 7) leanMass = value;
    }

    if (weight !== null) {
      if (fatMass == null && bodyFat != null) {
        fatMass = weight * (bodyFat / 100);
      }

      if (leanMass == null && fatMass != null) {
        leanMass = weight - fatMass;
      }

      return {
        sourceDate: group.date,
        weight,
        bodyFat,
        muscleMass,
        waterMass,
        fatMass,
        leanMass,
        rawGroup: group,
      };
    }
  }

  return null;
}

function parseAllWithingsMetrics(data) {
  const groups = data?.body?.measuregrps || [];
  const results = [];

  for (const group of groups) {
    let weight = null;
    let bodyFat = null;
    let muscleMass = null;
    let waterMass = null;
    let fatMass = null;
    let leanMass = null;

    for (const measure of group.measures || []) {
      const value = measure.value * Math.pow(10, measure.unit);

      if (measure.type === 1) weight = value;
      if (measure.type === 6) bodyFat = value;
      if (measure.type === 5) muscleMass = value;
      if (measure.type === 76) waterMass = value;
      if (measure.type === 4) fatMass = value;
      if (measure.type === 7) leanMass = value;
    }

    if (weight !== null) {
      if (fatMass == null && bodyFat != null) {
        fatMass = weight * (bodyFat / 100);
      }

      if (leanMass == null && fatMass != null) {
        leanMass = weight - fatMass;
      }

      results.push({
        sourceDate: group.date,
        weight,
        bodyFat,
        muscleMass,
        waterMass,
        fatMass,
        leanMass,
        rawGroup: group,
      });
    }
  }

  return results;
}

async function fetchWithingsMeasuresByRange(startdate, enddate) {
  let token =
    cleanValue(await getConfigValue("withings_access_token")) ||
    cleanValue(process.env.WITHINGS_ACCESS_TOKEN);

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  console.log(
    "WITHINGS MEASURES RANGE REQUEST",
    JSON.stringify({ startdate, enddate }),
  );

  const url = `https://wbsapi.withings.net/measure?action=getmeas&startdate=${startdate}&enddate=${enddate}`;

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  let data = await response.json();

  console.log(
    "WITHINGS MEASURES RANGE RESPONSE",
    JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      measureGroups: data?.body?.measuregrps?.length || 0,
    }),
  );

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    data = await response.json();

    console.log(
      "WITHINGS MEASURES RANGE RESPONSE RETRY",
      JSON.stringify({
        httpStatus: response.status,
        apiStatus: data?.status,
        measureGroups: data?.body?.measuregrps?.length || 0,
      }),
    );
  }

  if (!response.ok) {
    throw new Error(`Errore Withings HTTP ${response.status}`);
  }

  if (data.status !== 0) {
    throw new Error(`Errore Withings API status ${data.status}`);
  }

  return data;
}

function parseWithingsWebhookPayload(event) {
  try {
    let rawBody = event?.body ?? null;

    if (!rawBody) {
      console.log("WITHINGS PAYLOAD PARSE FAILED", "Missing body");
      return null;
    }

    if (event?.isBase64Encoded && typeof rawBody === "string") {
      rawBody = Buffer.from(rawBody, "base64").toString("utf8");
    }

    let body;

    if (typeof rawBody === "object") {
      body = rawBody;
    } else {
      const contentType =
        event?.headers?.["content-type"] ||
        event?.headers?.["Content-Type"] ||
        "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(rawBody);
        body = Object.fromEntries(params.entries());
      } else {
        try {
          body = JSON.parse(rawBody);
        } catch {
          const params = new URLSearchParams(rawBody);
          body = Object.fromEntries(params.entries());
        }
      }
    }

    return {
      userid: body.userid || null,
      appli: body.appli != null ? Number(body.appli) : null,
      startdate: body.startdate != null ? Number(body.startdate) : null,
      enddate: body.enddate != null ? Number(body.enddate) : null,
      date:
        body.date != null
          ? String(body.date).includes("-")
            ? body.date
            : Number(body.date)
          : null,
    };
  } catch (err) {
    console.log("WITHINGS PAYLOAD PARSE FAILED", err);
    return null;
  }
}

async function fetchWithingsActivityByDate(date) {
  let token =
    cleanValue(await getConfigValue("withings_access_token")) ||
    cleanValue(process.env.WITHINGS_ACCESS_TOKEN);

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  console.log("WITHINGS ACTIVITY REQUEST", JSON.stringify({ date }));

  const url = `https://wbsapi.withings.net/v2/measure?action=getactivity&date=${date}`;

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  let data = await response.json();

  console.log(
    "WITHINGS ACTIVITY RESPONSE",
    JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      activitiesCount: data?.body?.activities?.length || 0,
    }),
  );

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    data = await response.json();

    console.log(
      "WITHINGS ACTIVITY RESPONSE RETRY",
      JSON.stringify({
        httpStatus: response.status,
        apiStatus: data?.status,
        activitiesCount: data?.body?.activities?.length || 0,
      }),
    );
  }

  if (!response.ok) {
    throw new Error(`Errore Withings HTTP ${response.status}`);
  }

  if (data.status !== 0) {
    throw new Error(`Errore Withings API status ${data.status}`);
  }

  return data;
}

function parseLatestWithingsDailyActivity(data, fallbackDate) {
  const activities = data?.body?.activities || [];

  if (!activities.length) {
    return null;
  }

  const activity = activities[0];
  const activityDate = activity.date || fallbackDate;

  const activeCalories =
    activity.calories != null ? Number(activity.calories) : null;

  const totalCalories =
    activity.totalcalories != null ? Number(activity.totalcalories) : null;

  const soft = activity.soft != null ? Number(activity.soft) : null;
  const moderate = activity.moderate != null ? Number(activity.moderate) : null;
  const intense = activity.intense != null ? Number(activity.intense) : null;

  return {
    activityDate,
    sourceId: `withings-steps-${activityDate}`,
    sourceUrl: null,
    timezone: activity.timezone || null,
    deviceModel: activity.model || null,
    steps: activity.steps != null ? Number(activity.steps) : null,
    distanceKm:
      activity.distance != null ? Number(activity.distance) / 1000 : null,
    calories: activeCalories,
    totalCalories,
    soft,
    moderate,
    intense,
    elevationM: activity.elevation != null ? Number(activity.elevation) : null,
    rawActivity: activity,
  };
}

module.exports = {
  exchangeWithingsAuthorizationCode,
  saveWithingsTokens,
  getWithingsRedirectUri,
  refreshWithingsAccessToken,
  fetchWithingsMeasures,
  parseLatestWithingsMetrics,
  parseAllWithingsMetrics,
  fetchWithingsMeasuresByRange,
  fetchWithingsActivityByDate,
  parseLatestWithingsDailyActivity,
  parseWithingsWebhookPayload,
};
