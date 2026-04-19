const { getConfigValue, setConfigValue } = require("../../sheets");

async function refreshWithingsAccessToken() {
  const clientId = process.env.WITHINGS_CLIENT_ID;
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET;
  const refreshToken =
    (await getConfigValue("withings_refresh_token")) ||
    process.env.WITHINGS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Credenziali Withings mancanti per refresh token");
  }

  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  console.log("WITHINGS REFRESH TOKEN REQUEST", JSON.stringify({
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    hasRefreshToken: !!refreshToken
  }));

  const response = await fetch("https://wbsapi.withings.net/v2/oauth2", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const data = await response.json();

  console.log("WITHINGS REFRESH TOKEN RESPONSE", JSON.stringify({
    httpStatus: response.status,
    apiStatus: data?.status,
    hasAccessToken: !!data?.body?.access_token,
    hasRefreshToken: !!data?.body?.refresh_token
  }));

  if (!response.ok || data.status !== 0) {
    throw new Error(`Refresh token Withings fallito: HTTP ${response.status} / status ${data.status}`);
  }

  const newAccessToken = data.body.access_token;
  const newRefreshToken = data.body.refresh_token || refreshToken;

  await setConfigValue("withings_access_token", newAccessToken);
  await setConfigValue("withings_refresh_token", newRefreshToken);

  process.env.WITHINGS_ACCESS_TOKEN = newAccessToken;
  process.env.WITHINGS_REFRESH_TOKEN = newRefreshToken;

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken
  };
}

async function fetchWithingsMeasures() {
  let token =
    (await getConfigValue("withings_access_token")) ||
    process.env.WITHINGS_ACCESS_TOKEN;

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  const url = "https://wbsapi.withings.net/measure?action=getmeas";

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  let data = await response.json();

  console.log("WITHINGS MEASURES RESPONSE", JSON.stringify({
    httpStatus: response.status,
    apiStatus: data?.status,
    measureGroups: data?.body?.measuregrps?.length || 0
  }));

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    data = await response.json();

    console.log("WITHINGS MEASURES RESPONSE RETRY", JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      measureGroups: data?.body?.measuregrps?.length || 0
    }));
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
        rawGroup: group
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
        rawGroup: group
      });
    }
  }

  return results;
}

async function fetchWithingsMeasuresByRange(startdate, enddate) {
  let token =
    (await getConfigValue("withings_access_token")) ||
    process.env.WITHINGS_ACCESS_TOKEN;

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  console.log("WITHINGS MEASURES RANGE REQUEST", JSON.stringify({ startdate, enddate }));

  const url = `https://wbsapi.withings.net/measure?action=getmeas&startdate=${startdate}&enddate=${enddate}`;

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  let data = await response.json();

  console.log("WITHINGS MEASURES RANGE RESPONSE", JSON.stringify({
    httpStatus: response.status,
    apiStatus: data?.status,
    measureGroups: data?.body?.measuregrps?.length || 0
  }));

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    data = await response.json();

    console.log("WITHINGS MEASURES RANGE RESPONSE RETRY", JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      measureGroups: data?.body?.measuregrps?.length || 0
    }));
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
          : null
    };
  } catch (err) {
    console.log("WITHINGS PAYLOAD PARSE FAILED", err);
    return null;
  }
}

async function fetchWithingsActivityByDate(date) {
  let token =
    (await getConfigValue("withings_access_token")) ||
    process.env.WITHINGS_ACCESS_TOKEN;

  if (!token) {
    throw new Error("WITHINGS_ACCESS_TOKEN non configurato");
  }

  console.log("WITHINGS ACTIVITY REQUEST", JSON.stringify({ date }));

  const url = `https://wbsapi.withings.net/v2/measure?action=getactivity&date=${date}`;

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  let data = await response.json();

  console.log("WITHINGS ACTIVITY RESPONSE", JSON.stringify({
    httpStatus: response.status,
    apiStatus: data?.status,
    activitiesCount: data?.body?.activities?.length || 0
  }));

  if (response.status === 401 || data.status === 401) {
    const refreshed = await refreshWithingsAccessToken();
    token = refreshed.accessToken;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    data = await response.json();

    console.log("WITHINGS ACTIVITY RESPONSE RETRY", JSON.stringify({
      httpStatus: response.status,
      apiStatus: data?.status,
      activitiesCount: data?.body?.activities?.length || 0
    }));
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
    distanceKm: activity.distance != null ? Number(activity.distance) / 1000 : null,
    calories: activeCalories,
    totalCalories,
    soft,
    moderate,
    intense,
    elevationM: activity.elevation != null ? Number(activity.elevation) : null,
    rawActivity: activity
  };
}

module.exports = {
  refreshWithingsAccessToken,
  fetchWithingsMeasures,
  parseLatestWithingsMetrics,
  parseAllWithingsMetrics,
  fetchWithingsMeasuresByRange,
  fetchWithingsActivityByDate,
  parseLatestWithingsDailyActivity,
  parseWithingsWebhookPayload
};