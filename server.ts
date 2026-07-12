// NeuroHUD relay — the bridge between a Chrome tab that can talk to the headset and an OBS
// browser source that cannot.
//
// OBS renders browser sources in its own embedded Chromium, built without the Web Bluetooth
// backend; and Web Bluetooth needs a user gesture plus a device chooser that a background source
// can never present. So the device link has to live in a real Chrome tab, and the numbers have
// to cross a process boundary to reach OBS. This is that boundary.
//
//   Chrome  →  ws://127.0.0.1:8787/ws?role=source&t=…   (the link page pushes telemetry, ~10 Hz)
//   OBS     →  ws://127.0.0.1:8787/ws?role=view&t=…     (the overlay subscribes)
//
// Everything stays on the streamer's machine. Nothing is uploaded, and no EEG leaves the host.
//
// ## What is guarded, and what is not
//
// The two HTML pages are static markup and hold no secrets, so they are served plainly. The
// **data plane** — the WebSocket and `/state.json` — carries a live biometric readout and can
// put numbers on a live broadcast, so every one of those requests goes through `authorize()`.
// See `src/lib/security.ts` for why an *unauthenticated* localhost WebSocket is a hole and not
// a convenience.

import { mkdir, writeFile } from 'node:fs/promises';

import linkPage from './src/link/index.html';
import overlayPage from './src/overlay/index.html';
import { STATE_DIR, TEXT_FILE, loadConfig } from './src/lib/config';
import { SECURITY_HEADERS, authorize } from './src/lib/security';
import { formatTextLine, offlineTelemetry, type Telemetry } from './src/lib/wire';

const cfg = loadConfig();

/** OBS polls the text file itself; 2 Hz is plenty and keeps us off the disk. */
const TEXT_WRITE_MS = 500;
/** A telemetry frame is ~250 bytes. Anything larger is not one of ours. */
const MAX_PAYLOAD = 4 * 1024;

const TOPIC = 'telemetry';
const STANDDOWN = 'standdown';

type Role = 'source' | 'view';
interface SocketData {
	role: Role;
}

let last: Telemetry = offlineTelemetry(Date.now());
let sourceCount = 0;
let viewCount = 0;

let lastTextWrite = 0;
let lastTextLine: string | null = null;

await mkdir(STATE_DIR, { recursive: true });

/**
 * One opaque refusal for every failed check. Telling a caller *which* gate it failed tells an
 * attacker exactly what to fix next.
 */
function forbidden(): Response {
	return new Response('Forbidden', { status: 403, headers: SECURITY_HEADERS });
}

/** Guard a data-plane route. Returns the handler's response, or 403. */
function guarded(handler: (req: Request) => Response): (req: Request) => Response {
	return (req) => {
		const refused = authorize(req, cfg.token);
		if (refused) {
			console.warn(
				`  ✗ refused ${new URL(req.url).pathname} (${refused}) · origin ${req.headers.get('origin') ?? '—'}`
			);
			return forbidden();
		}
		return handler(req);
	};
}

/**
 * Mirror the current line into `state/focus.txt`, for streamers who want the number in their own
 * layout (OBS → Text (GDI+) → "Read from file") rather than our overlay. Throttled, and written
 * only when the line actually changes.
 */
async function writeTextFile(t: Telemetry): Promise<void> {
	const now = Date.now();
	if (now - lastTextWrite < TEXT_WRITE_MS) return;
	const line = formatTextLine(t);
	if (line === lastTextLine) return;
	lastTextWrite = now;
	lastTextLine = line;
	try {
		await writeFile(TEXT_FILE, line);
	} catch {
		/* the overlay is the primary path; a failed text mirror must not take the relay down */
	}
}

function publish(t: Telemetry): void {
	last = t;
	server.publish(TOPIC, JSON.stringify(t));
	void writeTextFile(t);
}

/** The source went away. Say so at once — a frozen number left on a live stream is a lie. */
function goOffline(): void {
	publish(offlineTelemetry(Date.now()));
}

const server = Bun.serve<SocketData, never>({
	port: cfg.port,
	hostname: cfg.host,

	routes: {
		// Static markup, no secrets. The token in the URL is consumed by the page's own script
		// when it opens its socket — it is never needed to fetch the HTML itself.
		'/link': linkPage,
		'/overlay': overlayPage,

		// Unauthenticated on purpose: no data, no token echo. Lets a streamer confirm the relay
		// is up without pasting a secret into a browser bar.
		'/health': () => Response.json({ ok: true }, { headers: SECURITY_HEADERS }),

		// The data plane. A live biometric readout is not a public resource, so: token required,
		// origin pinned, and emphatically no wildcard CORS.
		'/state.json': guarded(() => Response.json(last, { headers: SECURITY_HEADERS }))
	},

	fetch(req, srv) {
		const url = new URL(req.url);

		if (url.pathname === '/ws') {
			const refused = authorize(req, cfg.token);
			if (refused) {
				console.warn(
					`  ✗ refused /ws (${refused}) · origin ${req.headers.get('origin') ?? '—'}`
				);
				return forbidden();
			}
			const role: Role = url.searchParams.get('role') === 'source' ? 'source' : 'view';
			if (srv.upgrade(req, { data: { role } })) return undefined;
			return new Response('WebSocket upgrade failed', { status: 400, headers: SECURITY_HEADERS });
		}

		if (url.pathname === '/') return Response.redirect(`/link?t=${cfg.token}`, 302);

		return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
	},

	websocket: {
		maxPayloadLength: MAX_PAYLOAD,
		idleTimeout: 120,

		open(ws) {
			if (ws.data.role === 'source') {
				// The board accepts exactly one BLE central, so the relay accepts exactly one
				// source. A second link page takes over and the first is told to stand down —
				// otherwise two tabs fight over the headset and both lose it.
				if (sourceCount > 0) server.publish(STANDDOWN, 'superseded');
				ws.subscribe(STANDDOWN);
				sourceCount++;
				log(`link connected    (${sourceCount} source · ${viewCount} overlay)`);
				return;
			}

			ws.subscribe(TOPIC);
			viewCount++;
			// Send the last known state at once, so switching to the scene in OBS shows something
			// immediately rather than an empty box until the next push.
			ws.send(JSON.stringify(last));
			log(`overlay connected (${sourceCount} source · ${viewCount} overlay)`);
		},

		message(ws, raw) {
			if (ws.data.role !== 'source') return; // viewers are strictly read-only
			try {
				const t = JSON.parse(String(raw)) as Telemetry;
				if (t && typeof t === 'object' && typeof t.state === 'string' && t.v === 1) publish(t);
			} catch {
				/* a malformed frame is not worth dropping the link over */
			}
		},

		close(ws) {
			if (ws.data.role === 'source') {
				sourceCount = Math.max(0, sourceCount - 1);
				log(`link disconnected (${sourceCount} source · ${viewCount} overlay)`);
				if (sourceCount === 0) goOffline();
				return;
			}
			viewCount = Math.max(0, viewCount - 1);
		}
	}
});

function log(msg: string): void {
	console.log(`  ${new Date().toLocaleTimeString()}  ${msg}`);
}

const link = `${cfg.origin}/link?t=${cfg.token}`;
const overlay = `${cfg.origin}/overlay?t=${cfg.token}`;

console.log(`
  ┌─ NeuroHUD ─────────────────────────────────────────────────────────────

  1 ·  Open in Chrome, and link your headset
       ${link}

  2 ·  OBS  →  Sources  +  →  Browser  →  paste as URL
       ${overlay}
       Width 420  ·  Height 200  ·  untick "Shutdown source when not visible"

  Focus needs ≥ 175 SPS. Calibration takes 20 s — do it before you go live.
  No-graphics alternative:  OBS → Text (GDI+) → Read from file → state/focus.txt
${
	cfg.exposed
		? `
  ⚠  BOUND TO ${cfg.host} — NOT LOOPBACK
     Your live biometric feed is reachable from the local network. The token still
     guards it, but unless you meant this, stop and unset NEUROHUD_HOST.
`
		: ''
}
  Those URLs carry your token — treat them like a password. Don't show them on
  stream, and don't screenshot the OBS browser-source properties dialog.
  └────────────────────────────────────────────────────────────────────────
`);
