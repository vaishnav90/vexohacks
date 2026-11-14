import { defineConfig } from "vitest/config";

// Only this project's tests. The cloned vexo-open-kit/ folder has its own test suites (node:test), not ours.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
