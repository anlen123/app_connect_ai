import { defineConfig, devices } from '@playwright/test';
import { linuxLanUrl } from './src/server.js';
const port = Number(process.env.TEST_PORT || 18788);
const baseURL = process.env.TEST_BASE_URL || linuxLanUrl(port);
// Readiness probes must reach the actual Linux interface, not an environment HTTP proxy.
let localHost;
try { localHost = new URL(baseURL).hostname; } catch { throw new Error('TEST_BASE_URL 必须是合法的 http(s) 地址'); }
for (const key of ['NO_PROXY', 'no_proxy']) process.env[key] = [process.env[key], 'localhost', '127.0.0.1', localHost].filter(Boolean).join(',');
export default defineConfig({
  testDir: './e2e', timeout: 45000, workers: 1,
  use: { baseURL, screenshot: 'only-on-failure', trace: 'off' },
  projects: [
    { name: 'desktop-linux-http', use: { viewport: { width: 1400, height: 950 } } },
    { name: 'phone-linux-http', use: { ...devices['Pixel 5'] } },
  ],
  webServer: { command: 'node test/fixture-server.js', env: { PORT: String(port), FIXTURE_TOKEN: 'CustomPair_42' }, url: `${baseURL}/health`, reuseExistingServer: false, timeout: 20000 },
});
