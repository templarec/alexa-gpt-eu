const { Pool } = require("pg");

let globalPool = global.__DIETA_POSTGRES_POOL__;

function createPool() {
  return new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DATABASE,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,

    ssl:
      process.env.POSTGRES_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : false,

    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

if (!globalPool) {
  globalPool = createPool();

  globalPool.on("error", (error) => {
    console.error("POSTGRES POOL ERROR", error);
  });

  global.__DIETA_POSTGRES_POOL__ = globalPool;
}

async function query(text, params = []) {
  const start = Date.now();

  try {
    const result = await globalPool.query(text, params);

    console.log("POSTGRES QUERY", {
      durationMs: Date.now() - start,
      rowCount: result.rowCount,
    });

    return result;
  } catch (error) {
    console.error("POSTGRES QUERY FAILED", {
      message: error.message,
      code: error.code,
      detail: error.detail,
    });

    throw error;
  }
}

async function withTransaction(callback) {
  const client = await globalPool.connect();
  const start = Date.now();

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");

    console.log("POSTGRES TRANSACTION COMMITTED", {
      durationMs: Date.now() - start,
    });

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("POSTGRES TRANSACTION ROLLBACK FAILED", {
        message: rollbackError.message,
        code: rollbackError.code,
        detail: rollbackError.detail,
      });
    }

    console.error("POSTGRES TRANSACTION FAILED", {
      message: error.message,
      code: error.code,
      detail: error.detail,
    });

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool: globalPool,
  query,
  withTransaction,
};
