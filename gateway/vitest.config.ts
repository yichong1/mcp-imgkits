import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Local test fixtures only. Not production secrets, and not accepted by a deployed Worker.
const testTicketKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const testAdminToken = "test-admin-token";
process.env.TICKET_ENCRYPTION_KEY ??= testTicketKey;
process.env.ADMIN_TOKEN ??= testAdminToken;
process.env.MINERU_S2S_BEARER ??= "test-s2s-bearer";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Stub for wrangler services binding so local vitest can boot.
          serviceBindings: {
            TRANSMONKEY_MCP: async () =>
              new Response("vitest stub upstream", { status: 404 }),
            MARKANY_MCP: async () =>
              new Response("vitest stub upstream", { status: 404 }),
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            TICKET_ENCRYPTION_KEY: testTicketKey,
            ADMIN_TOKEN: testAdminToken,
            USA_BASE_URL: "https://usa.test",
            USA_TIMEOUT_MS: "250",
            MINERU_S2S_BEARER: "test-s2s-bearer",
            MINERU_BASE_URL: "https://mineru.test/api/mineru",
            MINERU_CHANNEL: "ai",
            MCP_CHARGE_COST: "1",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
