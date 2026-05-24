const { appendBodyRow } = require("../../sheets");
const {
  getLatestBodyMetric,
  insertBodyMetric,
} = require("../../repositories/bodyRepository");
const {
  maybeDecryptBodyNumber,
  shouldEncryptBodyForUser,
} = require("../../utils/crypto");
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

function parseOptionalNumber(value) {
  if (value === "" || value == null) {
    return "";
  }

  const parsed = Number(String(value).replace(",", "."));

  return Number.isFinite(parsed) ? parsed : "";
}

function parseStoredBodyNumber(value) {
  return parseOptionalNumber(maybeDecryptBodyNumber(value));
}

function buildSafeRawBodyPayload(body, userId) {
  const payload = { ...body };

  if (!shouldEncryptBodyForUser(userId)) {
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

async function createBodyFromHttp(
  event,
  { date, time, userId = DEFAULT_USER_ID },
) {
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

  try {
    await insertBodyMetric({
      userSlug: normalizedUserId,
      date: bodyDate,
      time: bodyTime,
      source,
      weight,
      bodyFat: bodyFat === "" ? null : bodyFat,
      muscleMass: muscleMass === "" ? null : muscleMass,
      waterMass: waterMass === "" ? null : waterMass,
      fatMass: fatMass === "" ? null : fatMass,
      leanMass: leanMass === "" ? null : leanMass,
      rawJson: safeRawBodyPayload,
    });

    console.log("POSTGRES BODY METRIC INSERTED");
  } catch (error) {
    console.error("POSTGRES BODY METRIC INSERT FAILED", {
      message: error.message,
      userId: normalizedUserId,
      date: bodyDate,
      source,
    });

    return jsonResponse(500, {
      success: false,
      error: "postgres_body_write_failed",
    });
  }

  try {
    await appendBodyRow(row);
  } catch (error) {
    console.error("SHEETS BODY SHADOW WRITE FAILED", {
      message: error.message,
      userId: normalizedUserId,
      date: bodyDate,
      source,
    });
  }

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
      encrypted_at_rest: shouldEncryptBodyForUser(normalizedUserId),
    },
  });
}

async function getLatestBodyFromHttp({ userId = DEFAULT_USER_ID }) {
  const normalizedUserId = normalizeUserId(userId);
  const latest = await getLatestBodyMetric(normalizedUserId);

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
    body: {
      user_id: normalizedUserId,
      date: latest.date,
      time: latest.time,
      source: latest.source,
      weight: parseStoredBodyNumber(latest.weight),
      bodyFat: parseStoredBodyNumber(latest.body_fat),
      muscleMass: parseStoredBodyNumber(latest.muscle_mass),
      waterMass: parseStoredBodyNumber(latest.water_mass),
      fatMass: parseStoredBodyNumber(latest.fat_mass),
      leanMass: parseStoredBodyNumber(latest.lean_mass),
      rawJson: latest.raw_json,
    },
  });
}

module.exports = {
  createBodyFromHttp,
  getLatestBodyFromHttp,
};
