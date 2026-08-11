import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Test files run one at a time. Several of them spawn six real OS
    // processes to reproduce multi-process contention against one SQLite
    // store; run in parallel those files compete for cores, which both
    // dilutes the contention they are trying to measure and makes them flaky
    // on a two-core CI runner. The whole suite is a few seconds, so the
    // determinism is close to free.
    fileParallelism: false,
    // The default 5s assumes in-process tests. The CLI suite runs the real
    // binary — a single test can spawn a dozen OS processes, each opening
    // SQLite and resolving git — and a loaded Windows CI runner spends 3-4s
    // on what Linux does in under one. Two F2/F3-era tests timed out on
    // exactly that runner with the suite otherwise green. A hang still
    // fails; it just takes 30s to say so, in a suite that runs serially.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
