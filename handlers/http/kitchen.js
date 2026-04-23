const fs = require("fs/promises");
const path = require("path");

const KITCHEN_STATE_PATH = path.join(
  __dirname,
  "../../data/kitchen-state.json",
);

async function ensureKitchenStateDir() {
  const dir = path.dirname(KITCHEN_STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

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

async function writeKitchenState(recipe) {
  await ensureKitchenStateDir();

  const state = {
    updatedAt: new Date().toISOString(),
    recipe: {
      title: recipe.title,
      servings: recipe.servings ?? null,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      notes: recipe.notes ?? "",
    },
  };

  await fs.writeFile(
    KITCHEN_STATE_PATH,
    JSON.stringify(state, null, 2),
    "utf8",
  );

  return state;
}

async function readKitchenState() {
  try {
    const raw = await fs.readFile(KITCHEN_STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        updatedAt: null,
        recipe: null,
      };
    }
    throw error;
  }
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

  const state = await writeKitchenState(body);

  return jsonResponse(200, {
    ok: true,
    message: "Ricetta inviata alla cucina",
    state,
  });
}

async function getKitchenCurrent() {
  const state = await readKitchenState();

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
