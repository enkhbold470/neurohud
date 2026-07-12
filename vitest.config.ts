import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Unit tests live beside the code they test. `tests/` is Playwright's — it drives a real
		// browser against a real relay, and vitest would otherwise try to collect those specs.
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
