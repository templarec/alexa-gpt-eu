require("dotenv").config();

const crypto = require("crypto");

const { google } = require("googleapis");
const { getAllMeals } = require("./sheets");

const { query } = require("./db/postgres");

const { maybeDecryptBodyNumber } = require("./utils/crypto");

const DEFAULT_USER_ID = String(process.env.DEFAULT_USER_ID || "lorenzo")
  .trim()
  .toLowerCase();

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
  return (
    String(value || DEFAULT_USER_ID)
      .trim()
      .toLowerCase() || DEFAULT_USER_ID
  );
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

      const result = await query(
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
        SELECT
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        WHERE NOT EXISTS (
          SELECT 1
          FROM meals
          WHERE user_id = $1
            AND date = $2
            AND COALESCE(time::text, '') = COALESCE($3::text, '')
            AND COALESCE(meal_type, '') = COALESCE($4, '')
            AND COALESCE(description, '') = COALESCE($5, '')
            AND calories = $6
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

      inserted += result.rowCount || 0;
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

      const result = await query(
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
        SELECT
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
        WHERE NOT EXISTS (
          SELECT 1
          FROM activities
          WHERE user_id = $1
            AND activity_date = $2
            AND COALESCE(source, '') = COALESCE($4, '')
            AND COALESCE(activity_type, '') = COALESCE($5, '')
            AND (
              ($12::text IS NOT NULL AND COALESCE(source_id, '') = COALESCE($12::text, ''))
              OR
              ($12::text IS NULL
                AND COALESCE(time::text, '') = COALESCE($3::text, '')
                AND COALESCE(description, '') = COALESCE($6, '')
                AND calories = $7
              )
            )
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

      inserted += result.rowCount || 0;
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

      const weight = maybeDecryptBodyNumber(row[4] || null);
      const bodyFat = maybeDecryptBodyNumber(row[5] || null);
      const muscleMass = maybeDecryptBodyNumber(row[6] || null);
      const waterMass = maybeDecryptBodyNumber(row[7] || null);
      const fatMass = maybeDecryptBodyNumber(row[8] || null);
      const leanMass = maybeDecryptBodyNumber(row[9] || null);

      const result = await query(
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
        SELECT
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        WHERE NOT EXISTS (
          SELECT 1
          FROM body_metrics
          WHERE user_id = $1
            AND date = $2
            AND COALESCE(time::text, '') = COALESCE($3::text, '')
            AND COALESCE(source, '') = COALESCE($4, '')
            AND COALESCE(weight, -1) = COALESCE($5, -1)
            AND COALESCE(body_fat, -1) = COALESCE($6, -1)
        )
        ON CONFLICT DO NOTHING
        `,
        [
          userId,
          row[1],
          row[2] || null,
          row[3] || null,
          weight,
          bodyFat,
          muscleMass,
          waterMass,
          fatMass,
          leanMass,
          hash,
        ],
      );

      inserted += result.rowCount || 0;
    } catch (error) {
      console.error("BODY BACKFILL FAILED", error.message);
    }
  }

  console.log("BACKFILL BODY DONE", { inserted });
}

async function backfillDailyStats(userMap) {
  console.log("BACKFILL DAILY STATS START");

  const rows = await getRowsFromRange("DailyStats!A:M");

  let insertedOrUpdated = 0;

  for (const row of rows.slice(1)) {
    if (!row[1] || !String(row[1]).trim()) {
      continue;
    }

    try {
      const userSlug = normalizeUserId(row[0]);
      const userId = userMap[userSlug];

      if (!userId) {
        console.log("DAILY STATS USER NOT FOUND", userSlug);
        continue;
      }

      const date = row[1];
      const intake = parseNullableNumber(row[2]) || 0;
      const activity = parseNullableNumber(row[3]) || 0;
      const net = parseNullableNumber(row[4]) || 0;
      const target = parseNullableNumber(row[5]) || 0;
      const tdeeFormula = parseNullableNumber(row[6]);
      const tdeeAdaptive = parseNullableNumber(row[7]);
      const tdeeFinal = parseNullableNumber(row[8]);
      const remaining = parseNullableNumber(row[9]) || 0;
      const weight = maybeDecryptBodyNumber(row[10] || null);
      const bodyFat = maybeDecryptBodyNumber(row[11] || null);
      const notes = row[12] || null;

      await query(
        `
        INSERT INTO daily_stats (
          user_id,
          date,
          intake,
          activity,
          net,
          target,
          remaining,
          protein,
          carbs,
          fat,
          weight,
          body_fat,
          tdee_formula,
          tdee_adaptive,
          tdee_final,
          notes,
          source,
          generated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()
        )
        ON CONFLICT (user_id, date)
        DO UPDATE SET
          intake = EXCLUDED.intake,
          activity = EXCLUDED.activity,
          net = EXCLUDED.net,
          target = EXCLUDED.target,
          remaining = EXCLUDED.remaining,
          weight = EXCLUDED.weight,
          body_fat = EXCLUDED.body_fat,
          tdee_formula = EXCLUDED.tdee_formula,
          tdee_adaptive = EXCLUDED.tdee_adaptive,
          tdee_final = EXCLUDED.tdee_final,
          notes = EXCLUDED.notes,
          source = EXCLUDED.source,
          generated_at = EXCLUDED.generated_at,
          updated_at = NOW()
        `,
        [
          userId,
          date,
          intake,
          activity,
          net,
          target,
          remaining,
          0,
          0,
          0,
          weight,
          bodyFat,
          tdeeFormula,
          tdeeAdaptive,
          tdeeFinal,
          notes,
          "sheets_backfill",
        ],
      );

      insertedOrUpdated += 1;
    } catch (error) {
      console.error("DAILY STATS BACKFILL FAILED", error.message);
    }
  }

  console.log("BACKFILL DAILY STATS DONE", { insertedOrUpdated });
}

async function run() {
  try {
    console.log("POSTGRES BACKFILL START");

    const userMap = await getUserMap();

    await backfillMeals(userMap);
    await backfillActivities(userMap);
    await backfillBody(userMap);
    await backfillDailyStats(userMap);

    console.log("POSTGRES BACKFILL DONE");

    process.exit(0);
  } catch (error) {
    console.error(error);

    process.exit(1);
  }
}

run();
