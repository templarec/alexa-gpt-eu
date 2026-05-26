const { parseSheetNumber } = require("./numbers-and-dates");

const AVG_STEP_LENGTH_M = 0.6;
const WALKING_KCAL_PER_KM = 71;
const RESIDUAL_STEPS_KCAL_PER_KM = 55;
const DEFAULT_BIKE_CADENCE_RPM = 60;

function normalizeActivityInput(row) {
  if (Array.isArray(row)) {
    return {
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
    };
  }

  return {
    date: row.activity_date || row.date || "",
    time: row.time || "",
    source: String(row.source || "")
      .trim()
      .toLowerCase(),
    activityType: String(row.activity_type || row.activityType || "")
      .trim()
      .toLowerCase(),
    description: row.description || "",
    rawCalories: Number(row.calories || 0),
    distanceKm: Number(row.distance_km || row.distanceKm || 0),
    durationMin: Number(row.duration_min || row.durationMin || 0),
    steps: Number(row.steps || 0),
  };
}

function buildNormalizedActivityEntries(activityRows) {
  const normalizedActivities = activityRows.map(normalizeActivityInput);

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

module.exports = {
  AVG_STEP_LENGTH_M,
  WALKING_KCAL_PER_KM,
  RESIDUAL_STEPS_KCAL_PER_KM,
  DEFAULT_BIKE_CADENCE_RPM,
  normalizeActivityInput,
  buildNormalizedActivityEntries,
};
