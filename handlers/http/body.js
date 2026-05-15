const { appendBodyRow, getLastBodyRow } = require("../../sheets");
const { parseJsonBody, jsonResponse } = require("../../utils/http");

function normalizeUserId(userId) {
  return (
    String(userId || "lorenzo")
      .trim()
      .toLowerCase() || "lorenzo"
  );
}

function parseOptionalNumber(value) {
  if (value === "" || value == null) {
    return "";
  }

  const parsed = Number(String(value).replace(",", "."));

  return Number.isFinite(parsed) ? parsed : "";
}

function buildSafeRawBodyPayload(body, userId) {
  const payload = { ...body };

  if (userId !== "elisa") {
    return payload;
  }

  for (const key of [
    "weight",
    "body_fat",
    "bodyFat",
    "muscle_mass",
    "muscleMass",
    "water_mass",
    "waterMass",
    "fat_mass",
    "fatMass",
    "lean_mass",
    "leanMass",
  ]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = "[encrypted]";
    }
  }

  return payload;
}

async function createBodyFromHttp(event, { date, time, userId = "lorenzo" }) {
  const body = parseJsonBody(event);
  const normalizedUserId = normalizeUserId(
    body.user_id || body.userId || userId,
  );

  const weight = parseOptionalNumber(body.weight);
  const bodyFat = parseOptionalNumber(body.body_fat ?? body.bodyFat);
  const muscleMass = parseOptionalNumber(body.muscle_mass ?? body.muscleMass);
  const waterMass = parseOptionalNumber(body.water_mass ?? body.waterMass);
  const fatMass = parseOptionalNumber(body.fat_mass ?? body.fatMass);
  const leanMass = parseOptionalNumber(body.lean_mass ?? body.leanMass);

  if (weight === "") {
    return jsonResponse(400, {
      success: false,
      error: "missing_weight",
      message: "Campo weight obbligatorio.",
    });
  }

  const source = String(body.source || "manual").trim() || "manual";
  const bodyDate = String(body.date || body.body_date || date).trim();
  const bodyTime = String(body.time || body.body_time || time).trim();

  const safeRawBodyPayload = buildSafeRawBodyPayload(body, normalizedUserId);

  const row = [
    normalizedUserId,
    bodyDate,
    bodyTime,
    source,
    weight,
    bodyFat,
    muscleMass,
    waterMass,
    fatMass,
    leanMass,
    JSON.stringify(safeRawBodyPayload),
  ];

  await appendBodyRow(row);

  return jsonResponse(200, {
    success: true,
    saved: {
      user_id: normalizedUserId,
      date: bodyDate,
      time: bodyTime,
      source,
      weight,
      body_fat: bodyFat === "" ? null : bodyFat,
      muscle_mass: muscleMass === "" ? null : muscleMass,
      water_mass: waterMass === "" ? null : waterMass,
      fat_mass: fatMass === "" ? null : fatMass,
      lean_mass: leanMass === "" ? null : leanMass,
      encrypted_at_rest: normalizedUserId === "elisa",
    },
  });
}

async function getLatestBodyFromHttp({ userId = "lorenzo" }) {
  const normalizedUserId = normalizeUserId(userId);
  const latest = await getLastBodyRow(normalizedUserId);

  if (!latest) {
    return jsonResponse(404, {
      success: false,
      error: "body_not_found",
      message: "Nessuna misurazione corporea trovata per questo utente.",
      user_id: normalizedUserId,
    });
  }

  return jsonResponse(200, {
    success: true,
    body: latest,
  });
}

module.exports = {
  createBodyFromHttp,
  getLatestBodyFromHttp,
};
