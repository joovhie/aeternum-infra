import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],

    // Includes test/integration now: test/integration/queries.test.ts runs
    // against a real in-process Postgres (pglite) rather than a mock, for
    // the constraint/upsert behavior mocks can't verify. See
    // test/helpers/pglite.ts.
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],

    // pglite's WASM cold start is ~4.5s per test file's beforeAll — well
    // under vitest's 5s default hook timeout most of the time, but close
    // enough to flake on a loaded CI runner. The per-file 15s override in
    // queries.test.ts's beforeAll already covers this; this is a lower
    // floor for everything else.
    testTimeout: 10_000,

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
