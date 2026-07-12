// The OBS browser source. Subscribes to the relay and renders telemetry — and, just as
// importantly, refuses to render anything it cannot stand behind.
//
// This file makes NO decision about whether a number is trustworthy. That already happened, in
// `wire.ts`, at the serialisation boundary: if a gate was shut, `focus` and `calm` arrived as
// `null` and there is simply nothing here to draw. The renderer cannot leak a score the signal
// did not earn, because it was never sent one.
//
// What this file DOES own is the failure the analyzer never has to think about: a stale reading
// left frozen on a live stream. If the Chrome tab crashes, the last good number would otherwise
// sit there looking perfectly healthy in front of an audience. So we watchdog it and fade out.

import { STALE_AFTER_MS, isStale, offlineTelemetry, type Telemetry } from '../lib/wire';
import { OVERLAY_FOOTER } from '../lib/wire';

const params = new URLSearchParams(location.search);

const panel = document.getElementById('panel') as HTMLDivElement;
const status = document.getElementById('status') as HTMLSpanElement;
const reason = document.getElementById('reason') as HTMLParagraphElement;
const footer = document.getElementById('footer') as HTMLElement;
const focusRow = document.getElementById('focus-row') as HTMLDivElement;
const calmRow = document.getElementById('calm-row') as HTMLDivElement;

const el = (row: HTMLElement, sel: string) => row.querySelector(sel) as HTMLElement;

footer.textContent = OVERLAY_FOOTER;

// ── streamer-facing options, all optional ──────────────────────────────────────────────
if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';
if (params.get('bars') === '0') panel.classList.add('nobars');

const scale = Number(params.get('scale'));
if (Number.isFinite(scale) && scale > 0.2 && scale <= 4) {
	document.documentElement.style.setProperty('--scale', String(scale));
}

/** The lamp / status colour per state. Only `live` is a colour that means "good". */
const STATE_COLOR: Record<Telemetry['state'], string> = {
	live: 'var(--focus)',
	calibrating: 'var(--calm)',
	connecting: 'var(--ink-dim)',
	nosignal: 'var(--warn)',
	'rate-too-low': 'var(--warn)',
	offline: 'var(--ink-faint)'
};

function statusLabel(t: Telemetry): string {
	switch (t.state) {
		case 'live':
			return t.flow ? 'in flow' : 'live';
		case 'calibrating':
			return `calibrating ${Math.ceil(t.calibrationLeftSec)}s`;
		case 'connecting':
			return 'connecting';
		case 'nosignal':
			return 'no signal';
		case 'rate-too-low':
			return 'rate too low';
		case 'offline':
			return 'offline';
	}
}

/** What to tell the streamer's audience — and the streamer — when a gate is shut. */
function reasonText(t: Telemetry): string {
	switch (t.state) {
		case 'nosignal':
			return 'Electrode not reading — check the earpad contact.';
		case 'rate-too-low':
			// focus.ts explains exactly why in fsReason (β above the passband, or mains folding
			// into β). Surface its words rather than inventing softer ones.
			return t.fsReason ? `${t.fsReason}.` : 'Sample rate cannot carry the focus score.';
		default:
			return '';
	}
}

function render(t: Telemetry): void {
	const live = t.state === 'live' && t.focus !== null && t.calm !== null;

	panel.dataset.state = t.state;
	panel.dataset.nodata = live ? '0' : '1';
	panel.classList.toggle('flow', live && t.flow);
	// Offline is the only state that hides the panel outright. Every other state still shows —
	// an audience watching a "no signal" light learns something true; a blank corner does not.
	panel.classList.toggle('visible', t.state !== 'offline');

	panel.style.setProperty('--state', STATE_COLOR[t.state]);
	status.textContent = statusLabel(t);
	reason.textContent = reasonText(t);

	setMetric(focusRow, t.focus);
	setMetric(calmRow, t.calm);
}

function setMetric(row: HTMLElement, value: number | null): void {
	// An em-dash, not a zero. Zero is a measurement; this is the absence of one.
	el(row, '.value').textContent = value === null ? '—' : String(Math.round(value));
	(el(row, '.fill') as HTMLElement).style.width = value === null ? '0%' : `${clamp(value)}%`;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

// ── the relay link ─────────────────────────────────────────────────────────────────────

let latest: Telemetry = offlineTelemetry(Date.now());
render(latest);

/**
 * Staleness watchdog. The relay tells us when the source disconnects cleanly, but a hard crash,
 * a suspended laptop, or a yanked WiFi adapter produces no such message — the socket just goes
 * quiet while the last number sits on screen, in front of an audience, looking fine.
 */
setInterval(() => {
	if (latest.state !== 'offline' && isStale(latest, Date.now())) {
		latest = offlineTelemetry(Date.now());
		render(latest);
	}
}, 500);

function connect(): void {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	// The token is baked into the overlay URL the server prints. It authorises this socket; see
	// server.ts for why an unauthenticated localhost WebSocket is a hole and not a convenience.
	const token = params.get('t') ?? '';
	const ws = new WebSocket(`${proto}//${location.host}/ws?role=view&t=${encodeURIComponent(token)}`);

	ws.onmessage = (e) => {
		try {
			const t = JSON.parse(e.data) as Telemetry;
			if (t && typeof t.state === 'string') {
				latest = t;
				render(t);
			}
		} catch {
			/* a malformed frame is not worth tearing the overlay down for */
		}
	};

	// OBS keeps a browser source alive across scene changes and stream restarts; the relay may
	// restart under it. Reconnect forever, quietly. A stream can run for eight hours.
	ws.onclose = () => {
		latest = offlineTelemetry(Date.now() - STALE_AFTER_MS - 1);
		render(latest);
		setTimeout(connect, 1000);
	};
	ws.onerror = () => ws.close();
}

connect();
