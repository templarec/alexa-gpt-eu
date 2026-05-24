const { appendActivityRow, getLatestWeight } = require("../../sheets");
const { insertActivity } = require("../../repositories/activityRepository");
const { parseJsonBody, jsonResponse } = require("../../utils/http");

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

function normalizeUserId(userId) {
  return (
    String(userId || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
}

function estimateCaloriesFromMetrics({
  activityType,
  distanceKm,
  durationMin,
  avgSpeedKmh,
  weightKg,
  steps,
}) {
  let effectiveDurationMin = durationMin;

  if (
    effectiveDurationMin == null &&
    distanceKm != null &&
    avgSpeedKmh != null &&
    avgSpeedKmh > 0
  ) {
    effectiveDurationMin = Math.round((distanceKm / avgSpeedKmh) * 60);
  }

  if (
    distanceKm != null &&
    effectiveDurationMin != null &&
    effectiveDurationMin > 0
  ) {
    const speed = distanceKm / (effectiveDurationMin / 60);
    let MET = 3;

    if (activityType === "bike") {
      if (speed < 16) MET = 4.5;
      else if (speed < 19) MET = 6;
      else if (speed < 22) MET = 8;
      else if (speed < 25) MET = 10;
      else MET = 12;
    } else {
      if (speed < 4) MET = 2.8;
      else if (speed < 5) MET = 3.5;
      else if (speed < 6) MET = 4.3;
      else if (speed < 8) MET = 6;
      else if (speed < 10) MET = 8;
      else MET = 10;
    }

    return {
      calories: Math.round(MET * weightKg * (effectiveDurationMin / 60)),
      effectiveDurationMin,
    };
  }

  if (distanceKm != null) {
    const perKmMultiplier = activityType === "bike" ? 0.35 : 0.75;

    return {
      calories: Math.round(distanceKm * weightKg * perKmMultiplier),
      effectiveDurationMin,
    };
  }

  if (steps != null) {
    return {
      calories: Math.round(steps * 0.04),
      effectiveDurationMin,
    };
  }

  return {
    calories: null,
    effectiveDurationMin,
  };
}

function shouldOverrideKomootCalories({
  activityType,
  calories,
  estimatedCalories,
}) {
  if (activityType !== "bike") {
    return false;
  }

  if (
    !Number.isFinite(calories) ||
    !Number.isFinite(estimatedCalories) ||
    estimatedCalories <= 0
  ) {
    return false;
  }

  return calories > estimatedCalories * 1.6;
}

async function createActivityFromHttp(
  event,
  { date, time, userId = DEFAULT_USER_ID },
) {
  const body = parseJsonBody(event);

  const normalizedUserId = normalizeUserId(
    body.user_id || body.userId || userId,
  );

  const source = String(body.source || "").trim();
  const activityType = String(body.activity_type || "").trim();
  const description = String(body.description || "").trim();
  const sourceId = String(body.source_id || "").trim();
  const sourceUrl = String(body.source_url || "").trim();

  const calories =
    body.calories === "" || body.calories == null
      ? null
      : Number(body.calories);

  const totalCalories =
    body.total_calories === "" || body.total_calories == null
      ? null
      : Number(body.total_calories);

  const distanceKm =
    body.distance_km === "" || body.distance_km == null
      ? null
      : Number(body.distance_km);

  const durationMin =
    body.duration_min === "" || body.duration_min == null
      ? null
      : Number(body.duration_min);

  const steps =
    body.steps === "" || body.steps == null ? null : Number(body.steps);

  const avgSpeedKmh =
    body.avg_speed_kmh === "" || body.avg_speed_kmh == null
      ? null
      : Number(body.avg_speed_kmh);

  let activityDate = date;
  let activityTime = time;

  if (body.activity_date) {
    const d = new Date(body.activity_date);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString();
      activityDate = iso.slice(0, 10);
      activityTime = iso.slice(11, 16);
    }
  }

  if (!source || !activityType) {
    return jsonResponse(400, {
      error: "source e activity_type sono obbligatori",
    });
  }

  if (
    [calories, totalCalories, distanceKm, durationMin, steps, avgSpeedKmh].some(
      (n) => n !== null && !Number.isFinite(n),
    )
  ) {
    return jsonResponse(400, {
      error:
        "calories, distance_km, duration_min e steps devono essere numeri validi",
    });
  }

  let weightKg = await getLatestWeight(normalizedUserId);

  if (!weightKg) {
    weightKg = Number(process.env.USER_WEIGHT_KG || 95);
  }

  const estimation = estimateCaloriesFromMetrics({
    activityType,
    distanceKm,
    durationMin,
    avgSpeedKmh,
    weightKg,
    steps,
  });

  let effectiveDurationMin = estimation.effectiveDurationMin;

  // Automatic calorie estimation if not provided
  let computedCalories = calories;

  // For Withings, trust provided active calories.
  if (source === "withings" && calories != null) {
    computedCalories = calories;
  }
  // For Komoot bike, ignore clearly inflated calories and fall back to internal estimation.
  else if (
    source === "komoot" &&
    shouldOverrideKomootCalories({
      activityType,
      calories,
      estimatedCalories: estimation.calories,
    })
  ) {
    console.log(
      "ACTIVITY CALORIES OVERRIDDEN",
      JSON.stringify({
        source,
        activityType,
        inputCalories: calories,
        estimatedCalories: estimation.calories,
        distanceKm,
        durationMin,
        effectiveDurationMin,
        avgSpeedKmh,
        steps,
        weightKg,
      }),
    );

    computedCalories = estimation.calories;
  }
  // If calories are missing, estimate them from available metrics.
  else if (computedCalories == null) {
    computedCalories = estimation.calories;
  }

  const row = [
    normalizedUserId,
    activityDate,
    activityTime,
    source,
    activityType,
    description,
    computedCalories ?? "",
    distanceKm ?? "",
    effectiveDurationMin ?? "",
    steps ?? "",
    avgSpeedKmh ?? "",
    sourceId ?? "",
    sourceUrl ?? "",
    JSON.stringify(body),
  ];

  try {
    await insertActivity({
      userSlug: normalizedUserId,
      activityDate,
      time: activityTime,
      source,
      activityType,
      description,
      calories: computedCalories,
      distanceKm,
      durationMin: effectiveDurationMin,
      steps,
      avgSpeedKmh,
      sourceId: sourceId || null,
      sourceUrl: sourceUrl || null,
      rawJson: body,
    });

    console.log("POSTGRES ACTIVITY UPSERTED");
  } catch (error) {
    console.error("POSTGRES ACTIVITY UPSERT FAILED", {
      message: error.message,
    });

    return jsonResponse(500, {
      error: "postgres_activity_write_failed",
    });
  }

  let result = null;

  try {
    result = await appendActivityRow(row);
  } catch (error) {
    console.error("SHEETS ACTIVITY SHADOW WRITE FAILED", {
      message: error.message,
      sourceId,
      userId: normalizedUserId,
    });
  }

  if (result && result.updated) {
    console.log(
      "ACTIVITY UPDATED",
      JSON.stringify({
        userId: normalizedUserId,
        date: activityDate,
        time: activityTime,
        source,
        activityType,
        sourceId,
        computedCalories,
        distanceKm,
        effectiveDurationMin,
        steps,
        avgSpeedKmh,
      }),
    );
  } else if (result && result.skipped) {
    console.log(
      "ACTIVITY SKIPPED",
      JSON.stringify({
        reason: result.reason || "skipped",
        sourceId,
      }),
    );

    return jsonResponse(200, {
      success: true,
      skipped: true,
      reason: result.reason,
      source_id: result.sourceId || null,
    });
  } else {
    console.log(
      "ACTIVITY SAVED",
      JSON.stringify({
        userId: normalizedUserId,
        date: activityDate,
        time: activityTime,
        source,
        activityType,
        sourceId,
        computedCalories,
        distanceKm,
        effectiveDurationMin,
        steps,
        avgSpeedKmh,
      }),
    );
  }

  return jsonResponse(200, {
    success: true,
    saved: {
      user_id: normalizedUserId,
      date: activityDate,
      time: activityTime,
      source,
      activity_type: activityType,
      description,
      source_id: sourceId || null,
      source_url: sourceUrl || null,
      calories: computedCalories,
      total_calories: totalCalories,
      distance_km: distanceKm,
      duration_min: effectiveDurationMin,
      steps,
      avg_speed_kmh: avgSpeedKmh,
    },
  });
}

module.exports = {
  createActivityFromHttp,
};
