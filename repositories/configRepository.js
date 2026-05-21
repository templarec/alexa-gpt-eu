const { query } = require("../db/postgres");

async function getUserConfigValueFromPostgres(userSlug, key) {
  const result = await query(
    `
    SELECT c.value
    FROM user_config c
    JOIN users u ON u.id = c.user_id
    WHERE u.slug = $1
      AND c.key = $2
    LIMIT 1
    `,
    [userSlug, key],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].value ?? null;
}

async function setUserConfigValueInPostgres(userSlug, key, value) {
  const result = await query(
    `
    INSERT INTO user_config (
      user_id,
      key,
      value,
      updated_at
    )
    SELECT
      u.id,
      $2,
      $3,
      NOW()
    FROM users u
    WHERE u.slug = $1
    ON CONFLICT (user_id, key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    RETURNING id
    `,
    [userSlug, key, String(value)],
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userSlug}`);
  }

  return {
    success: true,
  };
}

module.exports = {
  getUserConfigValueFromPostgres,
  setUserConfigValueInPostgres,
};
