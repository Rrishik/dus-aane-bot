// Coverage teardown: writes the cumulative istanbul coverage map to disk
// after every test file completes. Wired in only when COVERAGE=1 so normal
// `vitest run` invocations don't pay any setup overhead.
//
// Why afterAll (not just process.on('exit')): vitest workers exit via IPC
// disconnect, which doesn't reliably fire 'beforeExit'/'exit' listeners
// before the parent harness reads .coverage/. afterAll runs inside the
// worker on a guaranteed code path, so the snapshot is always flushed.
import { afterAll } from "vitest";

afterAll(() => {
  if (typeof globalThis.__appsScriptFlushCoverage === "function") {
    globalThis.__appsScriptFlushCoverage();
  }
});
