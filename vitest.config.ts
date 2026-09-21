import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // A container boot is not a unit test's worth of milliseconds, and the first run of a new
    // image pays for a pull on top.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
