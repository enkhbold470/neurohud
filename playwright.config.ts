import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.NEUROHUD_PORT ?? '8799';

/**
 * A fixed token for the test run, injected into the server rather than read from `state/token`.
 * A fresh clone (and every CI run) has no token file yet, and the server only writes one once it
 * boots — reading the file from a test would be a race. Pinning it here removes the file from
 * the picture entirely.
 */
const TOKEN = 'test-token-do-not-use-in-production-8f3a1c';

export default defineConfig({
	testDir: './tests',
	fullyParallel: false, // the relay accepts one source at a time, by design
	workers: 1,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'bun run server.ts',
		url: `http://127.0.0.1:${PORT}/health`,
		reuseExistingServer: false,
		env: { NEUROHUD_PORT: PORT, NEUROHUD_TOKEN: TOKEN },
		stdout: 'pipe'
	}
});

export { PORT, TOKEN };
