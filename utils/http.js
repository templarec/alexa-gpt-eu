function parseJsonBody(event) {
  if (!event.body) {
    throw new Error("Body mancante");
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;

  return JSON.parse(rawBody);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function getHeaderValue(headers, name) {
  const target = String(name).toLowerCase();

  const foundKey = Object.keys(headers || {}).find(
    (key) => String(key).toLowerCase() === target,
  );

  return foundKey ? headers[foundKey] : null;
}

function getAllowedApiKeys() {
  const keys = new Set();

  if (process.env.DIETA_API_KEY) {
    keys.add(String(process.env.DIETA_API_KEY));
  }

  if (process.env.API_KEY_ELISA) {
    keys.add(String(process.env.API_KEY_ELISA));
  }

  if (process.env.API_KEY_USER_MAP) {
    try {
      const parsed = JSON.parse(process.env.API_KEY_USER_MAP);

      for (const apiKey of Object.keys(parsed || {})) {
        if (!apiKey) {
          continue;
        }

        keys.add(String(apiKey));
      }
    } catch (error) {
      console.error(
        "API KEY USER MAP PARSE FAILED",
        JSON.stringify({ message: String(error?.message || error) }),
      );
    }
  }

  return [...keys];
}

function authorizeHttpRequest(event) {
  const allowedApiKeys = getAllowedApiKeys();

  if (allowedApiKeys.length === 0) {
    throw new Error("Nessuna API key configurata");
  }

  const headers = event.headers || {};

  const providedApiKey = getHeaderValue(headers, "x-api-key");
  const authHeader = getHeaderValue(headers, "authorization");

  if (providedApiKey && allowedApiKeys.includes(String(providedApiKey))) {
    return true;
  }

  if (!authHeader) {
    return false;
  }

  const bearerToken = String(authHeader)
    .replace(/^Bearer\s+/i, "")
    .trim();

  return allowedApiKeys.includes(bearerToken);
}

module.exports = {
  parseJsonBody,
  jsonResponse,
  authorizeHttpRequest,
};
