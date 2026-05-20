require("dotenv").config();

const crypto = require("crypto");

const { google } = require("googleapis");
const { getAllMeals } = require("./sheets");

const { query } = require("./db/postgres");

const { maybeDecryptBodyNumber } = require("./utils/crypto");

function hashRow(parts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

async function getUserMap() {
  const result = await query(`
    SELECT id, slug
    FROM users
  `);

  const map = {};

  for (const row of result.rows) {
    map[row.slug] = row.id;
  }

  return map;
}

function normalizeUserId(value) {
  if (!value) {
    return "lorenzo";
  }

  return String(value).trim().toLowerCase();
}

function parseNullableNumber(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(",", ".").trim());

  return Number.isFinite(parsed) ? parsed : null;
}

async function getSheetsClientForBackfill() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getRowsFromRange(range) {
  const sheets = await getSheetsClientForBackfill();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range,
  });

  return response.data.values || [];
}

async function backfillMeals(userMap) {
  console.log("BACKFILL MEALS START");

  const rows = await getAllMeals();

  let inserted = 0;

  for (const row of rows) {
    if (!row[0] || !String(row[0]).trim()) {
      continue;
    }
    try {
      const userSlug = normalizeUserId(row[0]);

      const userId = userMap[userSlug];

      if (!userId) {
        console.log("MEALS USER NOT FOUND", userSlug);
        continue;
      }

      const hash = hashRow(row);

      await query(
        `
        INSERT INTO meals (
          user_id,
          date,
          time,
          meal_type,
          description,
          calories,
          protein,
          carbs,
          fat,
          source,
          sheet_row_hash
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        )
        ON CONFLICT DO NOTHING
        `,
        [
          userId,
          row[1],
          row[2] || null,
          row[3],
          row[4] || null,
          parseNullableNumber(row[5]) || 0,
          parseNullableNumber(row[6]) || 0,
          parseNullableNumber(row[7]) || 0,
          parseNullableNumber(row[8]) || 0,
          row[10] || null,
          hash,
        ],
      );

      inserted += 1;
    } catch (error) {
      console.error("MEALS BACKFILL FAILED", error.message);
    }
  }

  console.log("BACKFILL MEALS DONE", { inserted });
}

async function backfillActivities(userMap) {
  console.log("BACKFILL ACTIVITIES START");

  const rows = await getRowsFromRange("Activity!A:N");

  let inserted = 0;

  for (const row of rows) {
    if (!row[0] || !String(row[0]).trim()) {
      continue;
    }
    try {
      const userSlug = normalizeUserId(row[0]);

      const userId = userMap[userSlug];

      if (!userId) {
        console.log("ACTIVITY USER NOT FOUND", userSlug);
        continue;
      }

      const hash = hashRow(row);

      await query(
        `
        INSERT INTO activities (
          user_id,
          activity_date,
          time,
          source,
          activity_type,
          description,
          calories,
          distance_km,
          duration_min,
          steps,
          avg_speed_kmh,
          source_id,
          source_url,
          raw_json,
          sheet_row_hash
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
        )
        ON CONFLICT DO NOTHING
        `,
        [
          userId,
          row[1],
          row[2] || null,
          row[3] || null,
          row[4],
          row[5] || null,
          parseNullableNumber(row[6]) || 0,
          parseNullableNumber(row[7]),
          parseNullableNumber(row[8]),
          parseNullableNumber(row[9]),
          parseNullableNumber(row[10]),
          row[11] || null,
          row[12] || null,
          row[13] ? JSON.parse(row[13]) : null,
          hash,
        ],
      );

      inserted += 1;
    } catch (error) {
      console.error("ACTIVITY BACKFILL FAILED", error.message);
    }
  }

  console.log("BACKFILL ACTIVITIES DONE", { inserted });
}

async function backfillBody(userMap) {
  console.log("BACKFILL BODY START");

  const rows = await getRowsFromRange("Body!A:K");

  let inserted = 0;

  for (const row of rows) {
    if (!row[0] || !String(row[0]).trim()) {
      continue;
    }
    try {
      const userSlug = normalizeUserId(row[0]);

      const userId = userMap[userSlug];

      if (!userId) {
        console.log("BODY USER NOT FOUND", userSlug);
        continue;
      }

      const hash = hashRow(row);

      await query(
        `
        INSERT INTO body_metrics (
          user_id,
          date,
          time,
          source,
          weight,
          body_fat,
          muscle_mass,
          water_mass,
          fat_mass,
          lean_mass,
          sheet_row_hash
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        )
        ON CONFLICT DO NOTHING
        `,
        [
          userId,
          row[1],
          row[2] || null,
          row[3] || null,
          maybeDecryptBodyNumber(row[4] || null),
          maybeDecryptBodyNumber(row[5] || null),
          maybeDecryptBodyNumber(row[6] || null),
          maybeDecryptBodyNumber(row[7] || null),
          maybeDecryptBodyNumber(row[8] || null),
          maybeDecryptBodyNumber(row[9] || null),
          hash,
        ],
      );

      inserted += 1;
    } catch (error) {
      console.error("BODY BACKFILL FAILED", error.message);
    }
  }

  console.log("BACKFILL BODY DONE", { inserted });
}

async function run() {
  try {
    console.log("POSTGRES BACKFILL START");

    const userMap = await getUserMap();

    await backfillMeals(userMap);
    await backfillActivities(userMap);
    await backfillBody(userMap);

    console.log("POSTGRES BACKFILL DONE");

    process.exit(0);
  } catch (error) {
    console.error(error);

    process.exit(1);
  }
}

run();
