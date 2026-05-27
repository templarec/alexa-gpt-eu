const DEFAULT_MINIMUM_CALORIES_FLOOR = {
  female: 1300,
  male: 1600,
  default: 1300,
};

const AGGRESSIVENESS_MULTIPLIERS = {
  conservative: 0.8,
  moderate: 1,
  aggressive: 1.15,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSex(value) {
  const sex = String(value || "")
    .trim()
    .toLowerCase();

  if (sex === "female" || sex === "f") return "female";
  if (sex === "male" || sex === "m") return "male";

  return "default";
}

function getBaseDeficitPercentFromBodyFat(bodyFatPercent, sex) {
  const bf = Number(bodyFatPercent);

  if (!Number.isFinite(bf)) {
    return sex === "female" ? 0.15 : 0.18;
  }

  if (sex === "female") {
    if (bf >= 40) return 0.22;
    if (bf >= 35) return 0.2;
    if (bf >= 30) return 0.17;
    if (bf >= 25) return 0.14;
    return 0.1;
  }

  if (bf >= 35) return 0.25;
  if (bf >= 30) return 0.22;
  if (bf >= 25) return 0.2;
  if (bf >= 20) return 0.17;
  return 0.12;
}

function computeAdaptiveTarget({
  tdee,
  weightKg,
  bodyFatPercent,
  sex,
  age,
  heightCm,
  aggressiveness = "moderate",
  minimumCaloriesFloor = null,
  maxDeficitPercent = null,
}) {
  const normalizedTdee = Number(tdee);
  const normalizedSex = normalizeSex(sex);
  const safetyFlags = [];

  if (!Number.isFinite(normalizedTdee) || normalizedTdee <= 0) {
    return {
      targetCalories: null,
      mode: "adaptive",
      recommendedDeficit: null,
      deficitPercent: null,
      aggressiveness,
      safetyFlags: ["invalid_tdee"],
      reasoning: "Adaptive target unavailable because TDEE is invalid.",
    };
  }

  const baseDeficitPercent = getBaseDeficitPercentFromBodyFat(
    bodyFatPercent,
    normalizedSex,
  );

  const multiplier =
    AGGRESSIVENESS_MULTIPLIERS[String(aggressiveness || "").toLowerCase()] ??
    AGGRESSIVENESS_MULTIPLIERS.moderate;

  const defaultMaxDeficitPercent = normalizedSex === "female" ? 0.22 : 0.27;
  const effectiveMaxDeficitPercent = Number.isFinite(Number(maxDeficitPercent))
    ? Number(maxDeficitPercent)
    : defaultMaxDeficitPercent;

  let deficitPercent = baseDeficitPercent * multiplier;
  deficitPercent = clamp(deficitPercent, 0.08, effectiveMaxDeficitPercent);

  const defaultFloor =
    DEFAULT_MINIMUM_CALORIES_FLOOR[normalizedSex] ||
    DEFAULT_MINIMUM_CALORIES_FLOOR.default;

  const floor = Number.isFinite(Number(minimumCaloriesFloor))
    ? Number(minimumCaloriesFloor)
    : defaultFloor;

  let targetCalories = Math.round(normalizedTdee * (1 - deficitPercent));
  let recommendedDeficit = Math.round(normalizedTdee - targetCalories);

  if (targetCalories < floor) {
    targetCalories = floor;
    recommendedDeficit = Math.round(normalizedTdee - targetCalories);
    deficitPercent = recommendedDeficit / normalizedTdee;
    safetyFlags.push("minimum_calories_floor_applied");
  }

  if (deficitPercent >= effectiveMaxDeficitPercent) {
    safetyFlags.push("max_deficit_percent_applied");
  }

  return {
    targetCalories,
    mode: "adaptive",
    recommendedDeficit,
    deficitPercent,
    aggressiveness,
    safetyFlags,
    reasoning: `Adaptive target based on TDEE, sex, body fat and aggressiveness profile.`,
    inputs: {
      tdee: normalizedTdee,
      weightKg: Number.isFinite(Number(weightKg)) ? Number(weightKg) : null,
      bodyFatPercent: Number.isFinite(Number(bodyFatPercent))
        ? Number(bodyFatPercent)
        : null,
      sex: normalizedSex,
      age: Number.isFinite(Number(age)) ? Number(age) : null,
      heightCm: Number.isFinite(Number(heightCm)) ? Number(heightCm) : null,
    },
  };
}

module.exports = {
  computeAdaptiveTarget,
};
