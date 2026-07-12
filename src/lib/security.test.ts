import { describe, expect, it } from 'vitest';

import {
	SECURITY_HEADERS,
	authorize,
	generateToken,
	hostAllowed,
	originAllowed,
	tokenMatches
} from './security';

const TOKEN = 'Ee9C3nJ2qk1sVb7xLp0aWd5oYh8tRu4mZi6gNc3fQe1';

/** Build a request the way a browser (or an attacker) would actually send it. */
function req(opts: {
	url?: string;
	origin?: string | null;
	host?: string | null;
	auth?: string;
}): Request {
	const headers = new Headers();
	if (opts.origin !== undefined && opts.origin !== null) headers.set('origin', opts.origin);
	if (opts.host !== null) headers.set('host', opts.host ?? '127.0.0.1:8787');
	if (opts.auth) headers.set('authorization', opts.auth);
	return new Request(opts.url ?? 'http://127.0.0.1:8787/ws?role=view', { headers });
}

describe('token', () => {
	it('generates a fresh, URL-safe, 256-bit token each time', () => {
		const a = generateToken();
		const b = generateToken();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // safe to drop in an OBS browser-source URL
		expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
	});

	it('accepts only the exact token', () => {
		expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
		expect(tokenMatches(TOKEN, TOKEN + 'x')).toBe(false);
		expect(tokenMatches(TOKEN, TOKEN.slice(0, -1))).toBe(false);
		expect(tokenMatches(TOKEN, '')).toBe(false);
		expect(tokenMatches(TOKEN, null)).toBe(false);
	});

	it('does not throw on a length mismatch — that would itself be a length oracle', () => {
		expect(() => tokenMatches(TOKEN, 'x')).not.toThrow();
		expect(tokenMatches(TOKEN, 'x')).toBe(false);
	});
});

describe('origin pinning — the cross-site WebSocket hijacking guard', () => {
	it('accepts our own pages', () => {
		expect(originAllowed(req({ origin: 'http://127.0.0.1:8787' }))).toBe(true);
		expect(originAllowed(req({ origin: 'http://localhost:8787' }))).toBe(true);
	});

	it('refuses a page on any other site', () => {
		// The scenario: the streamer has this open in another tab while they stream.
		expect(originAllowed(req({ origin: 'https://evil.example' }))).toBe(false);
		expect(originAllowed(req({ origin: 'http://evil.example' }))).toBe(false);
		// A lookalike hostname must not pass on a prefix/suffix match.
		expect(originAllowed(req({ origin: 'http://localhost.evil.example' }))).toBe(false);
		expect(originAllowed(req({ origin: 'http://notlocalhost' }))).toBe(false);
		expect(originAllowed(req({ origin: 'http://127.0.0.1.evil.example' }))).toBe(false);
	});

	it('refuses a non-http scheme', () => {
		expect(originAllowed(req({ origin: 'file://' }))).toBe(false);
		expect(originAllowed(req({ origin: 'chrome-extension://abc' }))).toBe(false);
	});

	it('lets a non-browser client through, and leaves it to the token', () => {
		// curl, a bot, Streamer.bot — these send no Origin and cannot be a CSWSH vector.
		expect(originAllowed(req({ origin: null }))).toBe(true);
		expect(authorize(req({ origin: null }), TOKEN)).toBe('token'); // still refused without one
	});
});

describe('host pinning — the DNS-rebinding guard', () => {
	it('accepts loopback', () => {
		expect(hostAllowed(req({ host: '127.0.0.1:8787' }))).toBe(true);
		expect(hostAllowed(req({ host: 'localhost:8787' }))).toBe(true);
		expect(hostAllowed(req({ host: 'localhost' }))).toBe(true);
	});

	it('refuses a rebound domain that resolves to 127.0.0.1', () => {
		// evil.example → 127.0.0.1 with a 1s TTL. The browser now believes it is same-origin with
		// the attacker's page, so the Origin check alone would pass it. The Host header does not
		// lie: it still says evil.example.
		expect(hostAllowed(req({ host: 'evil.example:8787' }))).toBe(false);
		expect(
			authorize(
				req({ host: 'evil.example:8787', origin: 'http://evil.example:8787', url: `http://127.0.0.1:8787/ws?t=${TOKEN}` }),
				TOKEN
			)
		).toBe('host');
	});

	it('refuses a missing host', () => {
		expect(hostAllowed(req({ host: null }))).toBe(false);
	});
});

describe('authorize — the one gate', () => {
	it('allows our own page carrying the token', () => {
		expect(
			authorize(
				req({ url: `http://127.0.0.1:8787/ws?role=view&t=${TOKEN}`, origin: 'http://127.0.0.1:8787' }),
				TOKEN
			)
		).toBeNull();
	});

	it('allows a bot with a bearer token', () => {
		expect(
			authorize(req({ url: 'http://127.0.0.1:8787/state.json', auth: `Bearer ${TOKEN}` }), TOKEN)
		).toBeNull();
	});

	it('refuses our own page with no token', () => {
		expect(authorize(req({ origin: 'http://127.0.0.1:8787' }), TOKEN)).toBe('token');
	});

	it('refuses a cross-site page even when it somehow has the token', () => {
		// Defence in depth: if the token leaks (a screenshot of the URL, a shared scene
		// collection), origin pinning still stops a web page from using it.
		expect(
			authorize(
				req({ url: `http://127.0.0.1:8787/ws?role=source&t=${TOKEN}`, origin: 'https://evil.example' }),
				TOKEN
			)
		).toBe('origin');
	});

	it('refuses a cross-site page trying to push fake numbers to the stream', () => {
		// The attack that matters most: fabricated telemetry appearing on a live broadcast,
		// attributed to the streamer.
		expect(
			authorize(
				req({ url: 'http://127.0.0.1:8787/ws?role=source', origin: 'https://evil.example' }),
				TOKEN
			)
		).not.toBeNull();
	});
});

describe('response headers', () => {
	it('never grants wildcard CORS — that would publish a biometric readout', () => {
		expect(SECURITY_HEADERS['access-control-allow-origin']).toBeUndefined();
		expect(Object.values(SECURITY_HEADERS)).not.toContain('*');
	});

	it('forbids caching and cross-origin embedding', () => {
		expect(SECURITY_HEADERS['cache-control']).toMatch(/no-store/);
		expect(SECURITY_HEADERS['cross-origin-resource-policy']).toBe('same-origin');
	});
});
