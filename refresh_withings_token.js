#!/usr/bin/env node

require("dotenv").config();

const http = require("http");
const { exec } = require("child_process");

const { query, closePool } = require("./db/postgres");

const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const CALLBACK_PORT = Number(process.env.WITHINGS_CALLBACK_PORT || 8787);
const CALLBACK_PATH = "/withings/callback";
const LOCAL_CALLBACK_URL = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI || LOCAL_CALLBACK_URL;
const WITHINGS_SCOPE =
  process.env.WITHINGS_SCOPE || "user.metrics,user.activity";
const WITHINGS_STATE = process.env.WITHINGS_STATE || "veyra";

function getArgValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));

  if (found) {
    return found.slice(prefix.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);

  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return null;
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function maskToken(token) {
  if (!token) return null;

  return {
    length: token.length,
    suffix: token.slice(-8),
  };
}

function buildAuthorizationUrl() {
  const clientId = requireEnv("WITHINGS_CLIENT_ID");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: WITHINGS_SCOPE,
    redirect_uri: REDIRECT_URI,
    state: WITHINGS_STATE,
  });

  return `${WITHINGS_AUTH_URL}?${params.toString()}`;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? `open \"${url}\"`
      : process.platform === "win32"
        ? `start \"\" \"${url}\"`
        : `xdg-open \"${url}\"`;

  exec(command, (error) => {
    if (error) {
      console.warn("FAILED TO OPEN BROWSER", {
        message: error.message,
      });
    }
  });
}

function waitForAuthorizationCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");

        if (!code) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/html",
        });

        res.end(`
          <html>
            <body style="font-family:sans-serif;padding:40px;">
              <h2>Withings authorization completed</h2>
              <p>You can now close this window.</p>
            </body>
          </html>
        `);

        server.close();
        resolve(code);
      } catch (error) {
        reject(error);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log("LOCAL CALLBACK SERVER READY", {
        callbackUrl: LOCAL_CALLBACK_URL,
      });
    });

    server.on("error", reject);
  });
}

async function requestWithingsTokens(code) {
  const clientId = requireEnv("WITHINGS_CLIENT_ID");
  const clientSecret = requireEnv("WITHINGS_CLIENT_SECRET");

  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const rawText = await response.text();
  let parsed;

  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Withings token response is not valid JSON: ${rawText}`);
  }

  if (!response.ok || parsed.status !== 0) {
    throw new Error(
      `Withings token request failed: HTTP ${response.status} / apiStatus ${parsed.status} / raw ${rawText}`,
    );
  }

  const accessToken = parsed.body?.access_token;
  const refreshToken = parsed.body?.refresh_token;
  const expiresIn = parsed.body?.expires_in;

  if (!accessToken || !refreshToken) {
    throw new Error(`Withings token response missing tokens: ${rawText}`);
  }

  return {
    accessToken,
    refreshToken,
    expiresIn,
  };
}

async function saveWithingsTokens({ accessToken, refreshToken, expiresIn }) {
  await query(
    `
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES
      ($1, $2::jsonb, NOW()),
      ($3, $4::jsonb, NOW()),
      ($5, $6::jsonb, NOW())
    ON CONFLICT (state_key)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
    `,
    [
      "config:withings_access_token",
      JSON.stringify({ value: accessToken }),
      "config:withings_refresh_token",
      JSON.stringify({ value: refreshToken }),
      "config:withings_token_expires_in",
      JSON.stringify({ value: expiresIn || null }),
    ],
  );
}

async function main() {
  const code = getArgValue("code");

  let authorizationCode = code;

  if (!authorizationCode) {
    const authorizationUrl = buildAuthorizationUrl();

    console.log("OPENING WITHINGS AUTHORIZATION FLOW", {
      redirectUri: REDIRECT_URI,
    });

    const codePromise = waitForAuthorizationCode();

    openBrowser(authorizationUrl);

    console.log("WAITING FOR WITHINGS CALLBACK...");

    authorizationCode = await codePromise;

    console.log("WITHINGS AUTHORIZATION CODE RECEIVED", {
      codeLength: authorizationCode.length,
    });
  }

  console.log("WITHINGS TOKEN REFRESH START", {
    redirectUri: REDIRECT_URI,
    codeLength: authorizationCode.length,
  });

  const tokens = await requestWithingsTokens(authorizationCode);

  await saveWithingsTokens(tokens);

  console.log("WITHINGS TOKENS SAVED", {
    accessToken: maskToken(tokens.accessToken),
    refreshToken: maskToken(tokens.refreshToken),
    expiresIn: tokens.expiresIn || null,
  });
}

main()
  .catch((error) => {
    console.error("WITHINGS TOKEN REFRESH FAILED", {
      message: error.message,
    });

    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool?.();
  });
