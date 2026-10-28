import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@agentpad/sdk/testing": path.resolve(__dirname, "src/testing/index.ts"), "@agentpad/sdk": path.resolve(__dirname, "src/index.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: "forks",
  },
});
