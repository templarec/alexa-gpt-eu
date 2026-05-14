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
    headers["x-api-key"] || headers["X-API-Key"] || headers["x-api-Key"];

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
