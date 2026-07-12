// Guarding a local relay that carries biometric data.
//
// ## Why a localhost server needs auth at all
//
// "It's only on localhost" is not a security boundary. Every page in every tab of the
// streamer's browser can reach `http://127.0.0.1:8787`, and **WebSockets are not protected by
// the same-origin policy** — no CORS preflight, no opt-in. Without the checks below, any site
// the streamer visits while streaming could:
//
//   - open `ws://127.0.0.1:8787/ws?role=source` and **push fabricated numbers onto their live
//     stream**, in front of an audience, attributed to them; or
//   - open `?role=view`, or simply `fetch('/state.json')`, and **exfiltrate a continuous
//     biometric readout** — when they are focused, when they blink, when they step away.
//
// That is cross-site WebSocket hijacking (CSWSH), and it is exactly the class of bug that makes
// "just bind it to localhost" tools dangerous. Three independent checks close it:
//
//   1. **Loopback bind** — the socket is not on the network at all by default.
//   2. **Origin + Host pinning** — a cross-site page announces its true `Origin`, so we can
//      refuse it; pinning `Host` additionally defeats DNS rebinding, where an attacker's domain
//      is re-resolved to 127.0.0.1 and would otherwise sail through an origin check.
//   3. **A bearer token** — generated, never hardcoded, never committed. This is what stops a
//      non-browser local process (a rogue npm postinstall, a game mod) that sends no Origin.
//
// Any one of these alone is bypassable. Together they are not.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Hosts we will serve to. Anything else in a `Host:` header is a rebinding attempt. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Compare in constant time. A naive `===` leaks the token one character at a time to anything
 * that can time our responses — and something that can open a socket to us can time us.
 */
export function tokenMatches(expected: string, given: string | null): boolean {
	if (!given) return false;
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(given, 'utf8');
	// timingSafeEqual throws on a length mismatch, which would itself be a length oracle.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** A fresh 256-bit token, URL-safe so it can live in the OBS browser-source URL. */
export function generateToken(): string {
	return randomBytes(32).toString('base64url');
}

/** Strip the port and normalise, so `localhost:8787` and `localhost` compare equal. */
function hostnameOf(hostHeader: string | null): string | null {
	if (!hostHeader) return null;
	const h = hostHeader.trim().toLowerCase();
	// IPv6 literals are bracketed: [::1]:8787
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		return end === -1 ? null : h.slice(0, end + 1);
	}
	return h.split(':')[0] ?? null;
}

/**
 * Reject a request whose `Host` is not a loopback name.
 *
 * This is the DNS-rebinding guard. An attacker points `evil.com` at 127.0.0.1 with a 1-second
 * TTL; the victim's browser then treats `http://evil.com:8787` as same-origin with the
 * attacker's page — so the Origin check passes — but the request still arrives here carrying
 * `Host: evil.com`. Pinning the host is what catches it.
 */
export function hostAllowed(req: Request): boolean {
	const host = hostnameOf(req.headers.get('host'));
	return host !== null && LOOPBACK_HOSTS.has(host);
}

/**
 * Reject a request from a page we did not serve.
 *
 * A browser always sets `Origin` on a WebSocket handshake and on cross-origin fetches, and a
 * page cannot forge it. Our own pages (including the one OBS loads, which is served from here)
 * send a loopback origin and pass.
 *
 * A missing `Origin` means a non-browser client — curl, a bot, Streamer.bot. Those cannot be a
 * CSWSH vector, so we allow them through *this* check and let the token decide.
 */
export function originAllowed(req: Request): boolean {
	const origin = req.headers.get('origin');
	if (origin === null || origin === 'null') return true; // non-browser; the token still applies
	try {
		const u = new URL(origin);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		return LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) || u.hostname === '::1';
	} catch {
		return false;
	}
}

export type DenyReason = 'host' | 'origin' | 'token' | null;

/**
 * The single gate every request and every socket upgrade passes through.
 * Returns `null` when the request is allowed, or which check refused it.
 */
export function authorize(req: Request, token: string): DenyReason {
	if (!hostAllowed(req)) return 'host';
	if (!originAllowed(req)) return 'origin';

	const url = new URL(req.url);
	// `?t=` for pages and sockets (a browser source URL cannot carry a header); `Authorization:
	// Bearer` for scripts and bots, which should not be putting secrets in a URL.
	const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
	const given = url.searchParams.get('t') ?? bearer;

	return tokenMatches(token, given) ? null : 'token';
}

/**
 * Headers on every response. The relay is a private instrument, not a web resource: nothing
 * embeds it, nothing reads it cross-origin, and no proxy or browser should keep a copy of a
 * biometric readout.
 */
export const SECURITY_HEADERS: Record<string, string> = {
	'cache-control': 'no-store, no-cache, must-revalidate',
	'cross-origin-resource-policy': 'same-origin',
	'cross-origin-opener-policy': 'same-origin',
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'SAMEORIGIN'
	// NOTE: deliberately NO `access-control-allow-origin`. Granting `*` here would hand a
	// continuous biometric readout to every site the streamer has open.
};
