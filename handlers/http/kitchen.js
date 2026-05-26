const { query } = require("../../db/postgres");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return null;
  }
}

function buildDefaultKitchenPayload() {
  return {
    title: "Nessuna ricetta inviata",
    servings: null,
    ingredients: [],
    steps: [],
    notes: "",
  };
}

function mapKitchenStateRow(row) {
  if (!row) {
    return {
      updatedAt: null,
      payload: buildDefaultKitchenPayload(),
    };
  }

  return {
    updatedAt: row.updated_at || null,
    payload: row.payload || buildDefaultKitchenPayload(),
  };
}

async function saveKitchenState(payload) {
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
    ["kitchen", JSON.stringify(payload)],
  );

  return mapKitchenStateRow(result.rows[0]);
}

async function getKitchenState() {
  const result = await query(
    `
    SELECT payload, updated_at
    FROM app_state
    WHERE state_key = $1
    LIMIT 1
    `,
    ["kitchen"],
  );

  return mapKitchenStateRow(result.rows[0]);
}

function validateKitchenPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Body JSON mancante o non valido";
  }

  if (!payload.title || typeof payload.title !== "string") {
    return "Campo 'title' obbligatorio";
  }

  if (
    payload.servings !== undefined &&
    payload.servings !== null &&
    (!Number.isInteger(payload.servings) || payload.servings <= 0)
  ) {
    return "Campo 'servings' deve essere un intero positivo";
  }

  if (!Array.isArray(payload.ingredients)) {
    return "Campo 'ingredients' deve essere un array";
  }

  if (!Array.isArray(payload.steps)) {
    return "Campo 'steps' deve essere un array";
  }

  if (!payload.ingredients.every((x) => typeof x === "string")) {
    return "Tutti gli elementi di 'ingredients' devono essere stringhe";
  }

  if (!payload.steps.every((x) => typeof x === "string")) {
    return "Tutti gli elementi di 'steps' devono essere stringhe";
  }

  if (payload.notes !== undefined && typeof payload.notes !== "string") {
    return "Campo 'notes' deve essere una stringa";
  }

  return null;
}

async function postKitchenDisplay(event) {
  const body = parseBody(event);

  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      error: "JSON non valido",
    });
  }

  const validationError = validateKitchenPayload(body);
  if (validationError) {
    return jsonResponse(400, {
      ok: false,
      error: validationError,
    });
  }

  const state = await saveKitchenState(body);

  return jsonResponse(200, {
    ok: true,
    message: "Ricetta inviata alla cucina",
    state,
  });
}

async function getKitchenCurrent() {
  const state = await getKitchenState();

  return jsonResponse(200, {
    ok: true,
    state,
  });
}

async function optionsKitchen() {
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

module.exports = {
  postKitchenDisplay,
  getKitchenCurrent,
  optionsKitchen,
};
