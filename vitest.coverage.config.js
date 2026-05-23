// Vitest config used only by `npm run coverage` (see scripts/coverage.js).
// Default `vitest run` uses no config file so this doesn't affect normal runs.
//
// The setupFile registers an afterAll hook that flushes the istanbul
// counters accumulated in tests/_loader.js to disk; we can't put this on
// the default config path because the coverage flush only matters when
// COVERAGE=1 and the loader's instrumentation branch is active.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/_coverageSetup.js"],
    reporters: ["dot"]
  }
});
