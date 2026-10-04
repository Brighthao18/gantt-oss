import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    retries: 0,
    workers: 2,
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4175', browserName: 'chromium',
        headless: true, timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
    webServer: { command: 'node scripts/serve.mjs --port 4175 --dist', url: 'http://127.0.0.1:4175',
        reuseExistingServer: false, timeout: 15000 }
});
