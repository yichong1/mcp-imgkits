import { defineConfig } from "vitest/config";

// Unit tests run in Node. The Worker entry itself is exercised through its
// fetch(request, env, ctx) surface with global fetch stubbed per test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
