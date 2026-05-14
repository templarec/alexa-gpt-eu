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

function authorizeHttpRequest(event) {
  const allowedApiKeys = [
    process.env.DIETA_API_KEY,
    process.env.API_KEY_ELISA,
  ].filter(Boolean);

  if (allowedApiKeys.length === 0) {
    throw new Error("Nessuna API key configurata");
  }

  const headers = event.headers || {};

  const providedApiKey =
    headers["x-api-key"] ||
    headers["X-API-Key"] ||
    headers["x-api-Key"] ||
    headers["X-Api-Key"] ||
    headers["X-API-KEY"];

  const authHeader = headers["authorization"] || headers["Authorization"];

  if (providedApiKey && allowedApiKeys.includes(providedApiKey)) {
    return true;
  }

  if (
    authHeader &&
    allowedApiKeys.some((key) => authHeader.trim() === `Bearer ${key}`)
  ) {
    return true;
  }

  return false;
}

module.exports = {
  parseJsonBody,
  jsonResponse,
  authorizeHttpRequest,
};
