const { query } = require("../db/postgres");

async function getUserConfigValueFromPostgres(userId, key) {
  const result = await query(
    `
    SELECT value
    FROM user_config
    WHERE user_id = $1
      AND key = $2
    LIMIT 1
    `,
    [userId, key],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].value ?? null;
}

async function setUserConfigValueInPostgres(userId, key, value) {
  await query(
    `
    INSERT INTO user_config (
      user_id,
      key,
      value,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      NOW()
    )
    ON CONFLICT (user_id, key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [userId, key, String(value)],
  );

  return {
    success: true,
  };
}

module.exports = {
  getUserConfigValueFromPostgres,
  setUserConfigValueInPostgres,
};
