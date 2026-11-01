import { applyD1Migrations, env } from "cloudflare:test";

const bindings = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
};

await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
