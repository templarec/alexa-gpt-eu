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
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function authorizeHttpRequest(event) {
  const expectedApiKey = process.env.DIETA_API_KEY;

  if (!expectedApiKey) {
    throw new Error("DIETA_API_KEY non configurata");
  }

  const headers = event.headers || {};

  const providedApiKey =
    headers["x-api-key"] ||
    headers["X-API-Key"] ||
    headers["x-api-Key"];

  const authHeader =
    headers["authorization"] ||
    headers["Authorization"];

  if (providedApiKey && providedApiKey === expectedApiKey) {
    return true;
  }

  if (authHeader && authHeader.trim() === `Bearer ${expectedApiKey}`) {
    return true;
  }

  return false;
}

module.exports = {
  parseJsonBody,
  jsonResponse,
  authorizeHttpRequest
};