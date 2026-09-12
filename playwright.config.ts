import { defineConfig, devices } from "@playwright/test";

// Every run starts its own `next dev` from this checkout. Another worktree's
// dev server can hold the same port, and reusing it would test that checkout's
// code and data, so a taken port fails the run instead of being reused.
// PW_PORT picks a different port.
const port = Number(process.env.PW_PORT || 3227);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PW_PORT must be a port number, got "${process.env.PW_PORT}"`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }],
  webServer: { command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`, url: baseURL, reuseExistingServer: false },
});
