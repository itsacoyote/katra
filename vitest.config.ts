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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
