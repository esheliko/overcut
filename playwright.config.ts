import { defineConfig } from "@playwright/test";

/** Smoke tests against the production build (`npm run build && npm run smoke`). SMOKE_BASE_URL tests an already-running site. */
export default defineConfig({
  testDir: "tests/smoke",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:4173",
    trace: "off",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ["--no-sandbox"] } : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
});
