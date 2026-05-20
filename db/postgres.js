const { Pool } = require("pg");

let globalPool = global.__DIETA_POSTGRES_POOL__;

function createPool() {
  console.log("POSTGRES ENV DEBUG", {
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DATABASE,
    user: process.env.POSTGRES_USER,
    ssl: process.env.POSTGRES_SSL,
  });
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

module.exports = {
  pool: globalPool,
  query,
};
