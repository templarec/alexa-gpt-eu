function calculateBmrMifflin({ weightKg, heightCm, age, sex }) {
  const weight = Number(weightKg || 0);
  const height = Number(heightCm || 0);
  const ageNum = Number(age || 0);
  const normalizedSex = String(sex || "")
    .trim()
    .toLowerCase();

  if (!weight || !height || !ageNum) {
    return null;
  }

  if (normalizedSex === "female" || normalizedSex === "f") {
    return 10 * weight + 6.25 * height - 5 * ageNum - 161;
  }

  return 10 * weight + 6.25 * height - 5 * ageNum + 5;
}

function calculateBmrKatch({ weightKg, bodyFatPercent }) {
  const weight = Number(weightKg || 0);
  const bf = Number(bodyFatPercent || 0);

  if (!weight || !bf) {
    return null;
  }

  const bodyFatRatio = bf / 100;
  const leanMass = weight * (1 - bodyFatRatio);

  if (!leanMass || !Number.isFinite(leanMass)) {
    return null;
  }

  return 370 + 21.6 * leanMass;
}

module.exports = {
  calculateBmrMifflin,
  calculateBmrKatch,
};
