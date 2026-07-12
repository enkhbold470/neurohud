// The Chrome half of NeuroHUD: owns the Web Bluetooth link and the DSP, and pushes telemetry to
// the relay so an OBS browser source can render it.
//
// This has to be a real Chrome tab. OBS's embedded Chromium ships without the Web Bluetooth
// backend, and Web Bluetooth needs a user gesture plus a device chooser that a background
// browser source cannot present. Hence the split.

import { ADC_PROFILES } from '../lib/adc';
import { NeuroLink, RATE_LADDER, V4_SAMPLE_RATE, type DeviceInfo, type LinkState } from '../lib/ble';
import { FocusEngine, focusFeasibility } from '../lib/focus';
import { deriveTelemetry, type LinkSnapshot } from '../lib/wire';

/** How often we push to the relay. The DSP recomputes ~8x/s; 10 Hz keeps the overlay smooth. */
const PUSH_HZ = 10;

/** The v4 board: ADS1220 24-bit, 3.3 V ref, PGA 1, AD8422 in front at x100. */
const SCALE = ADC_PROFILES.v4;

const BASELINE_KEY = 'neurohud.baseline.v1';
const REMEMBER_KEY = 'neurohud.remember.v1';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
	connect: $<HTMLButtonElement>('connect'),
	diag: $<HTMLButtonElement>('diag'),
	recal: $<HTMLButtonElement>('recal'),
	state: $('link-state'),
	focus: $('v-focus'),
	focusSub: $('s-focus'),
	calm: $('v-calm'),
	rms: $('v-rms'),
	blinks: $('v-blinks'),
	gateFs: $('gate-fs'),
	gateSignal: $('gate-signal'),
	gateCal: $('gate-cal'),
	url: $('overlay-url'),
	copy: $<HTMLButtonElement>('copy'),
	reveal: $<HTMLButtonElement>('reveal'),
	sps: $<HTMLSelectElement>('sps'),
	mains: $<HTMLSelectElement>('mains'),
	remember: $<HTMLSelectElement>('remember'),
	log: $('log')
};

// ── the overlay URL ────────────────────────────────────────────────────────────────────
// The token authorises the OBS browser source. It is a secret, and the single most likely way
// for it to leak is the streamer showing this page — so it stays masked until asked for.

const token = new URLSearchParams(location.search).get('t') ?? '';
const overlayUrl = `${location.origin}/overlay?t=${token}`;
const maskedUrl = `${location.origin}/overlay?t=${'•'.repeat(12)}`;
let revealed = false;

els.url.textContent = maskedUrl;
els.reveal.onclick = () => {
	revealed = !revealed;
	els.url.textContent = revealed ? overlayUrl : maskedUrl;
	els.url.classList.toggle('masked', !revealed);
	els.reveal.textContent = revealed ? 'Hide' : 'Show';
};
els.copy.onclick = async () => {
	await navigator.clipboard.writeText(overlayUrl);
	els.copy.textContent = 'Copied';
	setTimeout(() => (els.copy.textContent = 'Copy'), 1400);
};

// ── settings ───────────────────────────────────────────────────────────────────────────

let mains: 50 | 60 = 60; // default 60 Hz; do NOT "correct" this for North America
let requestedSps = V4_SAMPLE_RATE;

els.remember.value = localStorage.getItem(REMEMBER_KEY) ?? '1';
els.remember.onchange = () => {
	localStorage.setItem(REMEMBER_KEY, els.remember.value);
	if (els.remember.value === '0') localStorage.removeItem(BASELINE_KEY);
};

/** A baseline is only meaningful for the same headset on the same head in the same place. */
function savedBaseline(): number | undefined {
	if (els.remember.value !== '1') return undefined;
	const raw = localStorage.getItem(BASELINE_KEY);
	const v = raw === null ? NaN : Number(raw);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

els.mains.onchange = () => {
	mains = Number(els.mains.value) === 50 ? 50 : 60;
	rebuildEngine(fs);
};

els.sps.onchange = async () => {
	requestedSps = Number(els.sps.value);
	if (!link?.connected) return;
	log(`asking the board for ${requestedSps} SPS…`);
	// The board confirms the change with an INFO line, which lands in onInfo and re-tunes fs
	// there. Never assume the rate we asked for is the rate we got.
	await link.setSampleRate(requestedSps);
};

// ── DSP ────────────────────────────────────────────────────────────────────────────────

let fs = V4_SAMPLE_RATE;
let engine = new FocusEngine(fs, { line: mains, baselineEngagement: savedBaseline() });
let link: NeuroLink | null = null;
let linkState: LinkState = 'idle';
let device: string | null = null;
let lastBaseline: number | null = null;

/**
 * Rebuild the DSP for a new sample rate or mains setting. Both are baked into the filter chain
 * at construction, so there is nothing to mutate — a wrong `fs` slides every frequency by the
 * same ratio and would render real 10 Hz alpha somewhere else entirely.
 */
function rebuildEngine(newFs: number): void {
	fs = newFs;
	engine = new FocusEngine(fs, { line: mains, baselineEngagement: savedBaseline() });
}

// ── the relay socket ───────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;

function connectRelay(): void {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const sock = new WebSocket(
		`${proto}//${location.host}/ws?role=source&t=${encodeURIComponent(token)}`
	);
	sock.onopen = () => log('relay connected — the OBS overlay is now live');
	sock.onmessage = (e) => {
		// The relay accepts one source, because the board accepts one BLE central. If another
		// link page took over, stop fighting over the headset and let go.
		if (String(e.data) === 'superseded') {
			log('another link page took over — disconnecting this one');
			void disconnect();
		}
	};
	sock.onclose = () => {
		ws = null;
		setTimeout(connectRelay, 1000); // a stream can run for eight hours; reconnect forever
	};
	sock.onerror = () => sock.close();
	ws = sock;
}
connectRelay();

/** Push at a fixed rate, whatever the BLE frame cadence happens to be. */
setInterval(() => {
	const snapshot: LinkSnapshot = {
		linkState,
		metrics: linkState === 'live' ? engine.read() : null,
		device,
		fs,
		at: Date.now()
	};
	const t = deriveTelemetry(snapshot);
	render(t, snapshot);

	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(t));

	// The baseline freezes once, mid-session. Persist it the moment it exists, so a returning
	// streamer doesn't burn 20 s of their intro recalibrating.
	const b = snapshot.metrics?.baseline ?? null;
	if (b !== null && b !== lastBaseline) {
		lastBaseline = b;
		if (els.remember.value === '1') localStorage.setItem(BASELINE_KEY, String(b));
	}
}, 1000 / PUSH_HZ);

// ── rendering ──────────────────────────────────────────────────────────────────────────

function render(t: ReturnType<typeof deriveTelemetry>, s: LinkSnapshot): void {
	const m = s.metrics;

	setStat(els.focus, t.focus === null ? null : Math.round(t.focus));
	setStat(els.calm, t.calm === null ? null : Math.round(t.calm));
	setStat(els.rms, m?.signalOk ? Math.round(m.rmsUv) : null);
	els.blinks.textContent = String(m?.blinks ?? 0);
	els.blinks.classList.toggle('dead', !m?.blinks);

	els.focusSub.textContent =
		t.state === 'live'
			? t.flow
				? 'in flow · above your baseline'
				: 'vs. your own baseline'
			: t.state === 'calibrating'
				? `calibrating · ${Math.ceil(t.calibrationLeftSec)}s left`
				: 'not measuring';

	// The three gates, spelled out. This page is where a streamer fixes them; the overlay only
	// reports that one is shut.
	const feas = focusFeasibility(fs, mains);
	gate(
		els.gateFs,
		m ? m.fsOk : null,
		feas.ok ? `${fs} SPS — enough for β up to 30 Hz` : (feas.reason ?? 'unusable rate')
	);
	gate(
		els.gateSignal,
		m ? m.signalOk : null,
		m?.signalOk
			? `${Math.round(m.rmsUv)} µV RMS — electrode is reading`
			: 'flat trace — check the earpad contact'
	);
	gate(
		els.gateCal,
		m ? !m.calibrating : null,
		m && !m.calibrating
			? `frozen at E₀ = ${m.baseline?.toFixed(3)} — 50 on the overlay means this`
			: m
				? `${Math.ceil(m.calibrationLeftSec)}s of good signal still needed`
				: 'not calibrated'
	);
}

function setStat(el: HTMLElement, v: number | null): void {
	el.textContent = v === null ? '—' : String(v);
	el.classList.toggle('dead', v === null);
}

function gate(el: HTMLElement, ok: boolean | null, why: string): void {
	el.dataset.ok = ok === null ? '' : ok ? '1' : '0';
	(el.querySelector('.why') as HTMLElement).textContent = why;
}

function setLinkState(state: LinkState, detail: string): void {
	linkState = state;
	els.state.textContent = detail;
	els.state.dataset.tone = state === 'error' ? 'error' : state === 'live' ? 'live' : '';
	const live = state === 'live';
	els.connect.textContent = live ? 'Disconnect' : 'Connect headset';
	els.diag.disabled = !live;
	els.recal.disabled = !live;
}

function log(msg: string): void {
	const time = new Date().toLocaleTimeString();
	els.log.textContent = `${time}  ${msg}\n${els.log.textContent}`.split('\n').slice(0, 12).join('\n');
}

// ── connect / disconnect ───────────────────────────────────────────────────────────────

els.connect.onclick = () => (link?.connected ? disconnect() : connect());

async function connect(): Promise<void> {
	if (!NeuroLink.supported) {
		setLinkState('error', 'Web Bluetooth is unavailable — use Chrome or Edge on desktop.');
		return;
	}

	link = new NeuroLink({
		onSamples: (counts) => engine.pushCounts(counts, SCALE),
		onState: (s, detail) => setLinkState(s, detail),
		onInfo: (info: DeviceInfo) => {
			// The board is the authority on its own sample rate. A hard-coded fs is how real
			// 10 Hz alpha ends up rendered at 34 Hz.
			if (info.sps && info.sps !== fs) {
				log(`board reports ${info.sps} SPS — retuning the DSP`);
				rebuildEngine(info.sps);
				const nearest = RATE_LADDER.reduce((a, b) =>
					Math.abs(b - info.sps!) < Math.abs(a - info.sps!) ? b : a
				);
				els.sps.value = String(nearest);
			}
			device = info.name ?? link?.deviceName ?? null;
		},
		onDiag: (r) => log(r.raw),
		onStatusText: (line) => log(line)
	});

	try {
		await link.connect();
		device = link.deviceName;
		// If the board is older than v4.1 it never sends INFO, and `fs` stays at the v4 fallback.
		if (!link.deviceInfo) log(`no INFO from the board — assuming ${V4_SAMPLE_RATE} SPS (firmware < v4.1)`);
		if (requestedSps !== fs) await link.setSampleRate(requestedSps);
		log(`linked to ${device}`);
	} catch (e) {
		setLinkState('error', e instanceof Error ? e.message : String(e));
	}
}

async function disconnect(): Promise<void> {
	await link?.disconnect();
	link = null;
	device = null;
	engine.reset(true); // keep the baseline; the headset didn't move
	setLinkState('idle', 'Not connected.');
}

els.diag.onclick = async () => {
	els.diag.disabled = true;
	log('running on-board diagnostic (~1.2 s)…');
	try {
		await link?.diag();
	} catch (e) {
		log(e instanceof Error ? e.message : String(e));
	}
	els.diag.disabled = false;
};

els.recal.onclick = () => {
	localStorage.removeItem(BASELINE_KEY);
	lastBaseline = null;
	rebuildEngine(fs); // drops the saved baseline and restarts the 20 s calibration
	log('recalibrating — hold still and stay off stream for 20 s');
};

setLinkState('idle', 'Not connected.');
