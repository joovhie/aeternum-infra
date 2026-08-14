import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],

    // Unit tests only for now — no integration/ suite yet, since there's no
    // live Postgres or Galxe sandbox to run against in CI. Add
    // test/integration when those are available, following apps/keeper's split.
    include: ["test/unit/**/*.test.ts"],

    pool: "forks",
    environment: "node",
    reporters: ["verbose"],

    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
