import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: "forks",
  },
});
