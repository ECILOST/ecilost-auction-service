/** Mismo Postgres que el desarrollo local, otro esquema: las pruebas lo vacian a voluntad. */
export const integrationDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://auction:auction@localhost:5436/ecilost_auction?schema=auction_it';
