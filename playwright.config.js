import { defineConfig } from '@playwright/test'

// E2E tests load the REAL dev build in Chromium, from their own folder
// (dist-chrome-e2e: yarn build-chrome-e2e). X is never reached: every x.com
// request a test makes is answered by a route.
export default defineConfig({
    testDir: './tests/e2e',
    testMatch: /.*\.spec\.js/,
    timeout: 30000,
    retries: 0,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
})
