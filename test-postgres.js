require("dotenv").config();

const { query } = require("./db/postgres");

async function main() {
  const result = await query("SELECT NOW()");

  console.log(result.rows);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
