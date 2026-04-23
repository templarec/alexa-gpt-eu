const { saveKitchenState, getKitchenState } = require("../../sheets");

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
