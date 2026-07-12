// The contract between the Chrome link page and the OBS overlay — and the one place the
// honesty gate is enforced.
//
// ## Why the gate lives here and not in the renderer
//
// The overlay is pointed at an audience. This signal has three well-understood ways of lying,
// and `FocusEngine` already detects all three (`signalOk`, `calibrating`, `fsOk`):
//
//   - A detached electrode collapses alpha+theta to the noise floor. The ungated Pope ratio
//     then explodes and reads as *flawless concentration*.
//   - Below 175 SPS the score is not defensible at all: beta reaches 30 Hz but sits above the
//     passband, and 60 Hz mains aliases straight into beta (→15 Hz at 45 SPS, →30 Hz at 90),
//     where it cannot be notched. Mains hum reads as concentration.
//   - Before the baseline is frozen, the score has no referent — 50 means nothing yet.
//
// So `focus` and `calm` are **null on the wire** unless every gate is open. The overlay cannot
// render a number it has not earned, because there is no number to render. A renderer bug can
// leak a layout mistake to an audience; it cannot leak a fabricated score.
//
// A fourth failure is unique to streaming and has no counterpart in the analyzer: **stale
// data**. If the Chrome tab crashes, the last good number would otherwise sit frozen on stream,
// looking perfectly healthy. `isStale()` is the watchdog; the overlay fades out rather than
// hold a corpse on screen.

import type { LinkState } from './ble';
import { FLOW_THRESHOLD, type FocusMetrics } from './focus';

/** Wire format version. Bump when `Telemetry` changes shape. */
export const WIRE_VERSION = 1;

/**
 * No telemetry for this long and the overlay stops trusting what it is holding.
 * The link pushes at ~10 Hz, so 3 s is ~30 missed frames — comfortably past a hiccup.
 */
export const STALE_AFTER_MS = 3000;

/**
 * Shown on the overlay, always. The score is relative to the wearer's own frozen baseline and
 * is not comparable between people; the sensor is a single around-ear dry electrode — never
 * "Fp1", "frontal" or "prefrontal", which are places this device does not touch.
 */
export const OVERLAY_FOOTER = 'relative to my own baseline · single around-ear channel';

export type StreamState =
	/** Nothing is pushing telemetry — no link page open, or it died. */
	| 'offline'
	/** Linked, but the analysis window is still filling. */
	| 'connecting'
	/** Good signal, but the baseline is not frozen yet. The score has no referent. */
	| 'calibrating'
	/** Every gate open. This is the only state that carries a number. */
	| 'live'
	/** The trace is flat — electrode detached, or nothing connected. */
	| 'nosignal'
	/** This sample rate physically cannot carry `beta/(alpha+theta)`. */
	| 'rate-too-low';

export interface Telemetry {
	v: typeof WIRE_VERSION;
	/** Epoch ms at which the link sampled this. Drives the staleness watchdog. */
	t: number;
	state: StreamState;
	/**
	 * 0–100, or **null unless `state === 'live'`**. 50 is the wearer's own frozen baseline, so
	 * this is a within-session, within-person relative signal. It is not comparable between
	 * people, and it is not a measurement of anyone's cognition.
	 */
	focus: number | null;
	/** 0–100 alpha share, or null unless live. A relaxation cue — NOT `100 - focus`. */
	calm: number | null;
	/** `focus >= FLOW_THRESHOLD`. Always false when there is no number. */
	flow: boolean;
	blinks: number;
	/** Seconds of good signal still needed before the baseline freezes. */
	calibrationLeftSec: number;
	fs: number | null;
	/** Why this rate cannot carry the score, when it cannot. */
	fsReason: string | null;
	device: string | null;
	/** The frozen baseline engagement, once known. */
	baseline: number | null;
	/**
	 * True when this came from the synthetic-headset dev harness rather than a real electrode.
	 *
	 * The simulator exists so the pipeline can be tested without hardware — but it can drive the
	 * same overlay that goes on a live broadcast, so a simulated score MUST be able to say so.
	 * The overlay renders a `SIM` badge on this, and it is not suppressible. A synthetic number
	 * that an audience mistakes for a measured one is the exact failure this codebase exists to
	 * refuse; the fact that it would be *our own* harness doing the lying makes it worse, not
	 * more forgivable.
	 */
	sim: boolean;
}

/** Everything the link page knows at one instant. The only input to the gate. */
export interface LinkSnapshot {
	linkState: LinkState;
	metrics: FocusMetrics | null;
	device: string | null;
	fs: number | null;
	/** Epoch ms. Passed in rather than read from the clock, so this stays a pure function. */
	at: number;
	/** Only the dev harness sets this. The real link page never does. */
	sim?: boolean;
}

/** One decimal is all the precision this signal has ever earned; more just jitters on screen. */
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/**
 * Collapse the link state and the three `FocusEngine` gates into one `StreamState`, and emit a
 * number only if every one of them is open.
 *
 * Gate precedence is deliberate. `rate-too-low` outranks `nosignal` because it is the hard
 * blocker: fixing the electrode still leaves no usable score at 90 SPS, so the rate is the
 * message the streamer actually needs to see.
 */
export function deriveTelemetry(s: LinkSnapshot): Telemetry {
	const m = s.metrics;

	const base: Telemetry = {
		v: WIRE_VERSION,
		t: s.at,
		state: 'offline',
		focus: null,
		calm: null,
		flow: false,
		blinks: m?.blinks ?? 0,
		calibrationLeftSec: m?.calibrationLeftSec ?? 0,
		fs: s.fs,
		fsReason: m?.fsReason ?? null,
		device: s.device,
		baseline: m?.baseline ?? null,
		sim: s.sim === true
	};

	if (s.linkState !== 'live') {
		// 'idle' means nobody ever linked; the rest are all in-flight or broken.
		base.state = s.linkState === 'idle' ? 'offline' : 'connecting';
		return base;
	}
	if (!m || m.warmingUp) {
		base.state = 'connecting';
		return base;
	}
	if (!m.fsOk) {
		base.state = 'rate-too-low';
		return base;
	}
	if (!m.signalOk) {
		base.state = 'nosignal';
		return base;
	}
	if (m.calibrating) {
		base.state = 'calibrating';
		return base;
	}

	// Every gate open. `calm` is bounded and would technically survive calibration and a lower
	// rate, but it ships with `focus` so the overlay is never half-populated — a lone CALM bar
	// next to a blank FOCUS bar reads as "focus is zero", which is a different lie.
	base.state = 'live';
	base.focus = round1(m.focus);
	base.calm = round1(m.calm);
	base.flow = m.focus >= FLOW_THRESHOLD;
	return base;
}

/** The payload a viewer gets when no link page is pushing. Carries no number, by construction. */
export function offlineTelemetry(at: number): Telemetry {
	return {
		v: WIRE_VERSION,
		t: at,
		state: 'offline',
		focus: null,
		calm: null,
		flow: false,
		blinks: 0,
		calibrationLeftSec: 0,
		fs: null,
		fsReason: null,
		device: null,
		baseline: null,
		sim: false
	};
}

/** True once telemetry is too old to trust. The overlay fades rather than freeze a stale score. */
export function isStale(t: Telemetry, now: number, maxAgeMs = STALE_AFTER_MS): boolean {
	return now - t.t > maxAgeMs;
}

/**
 * One line for an OBS **Text (GDI+) → read from file** source — the no-graphics path, for a
 * streamer who wants the number in their own layout. Same gate: no number unless live.
 */
export function formatTextLine(t: Telemetry): string {
	// The SIM marker rides along here too. This line can be dropped straight into an OBS text
	// source, where there is even less room for context than on the overlay.
	const sim = t.sim ? 'SIM · ' : '';
	switch (t.state) {
		case 'live':
			return `${sim}Focus ${Math.round(t.focus!)}  ·  Calm ${Math.round(t.calm!)}`;
		case 'calibrating':
			return `Calibrating… ${Math.ceil(t.calibrationLeftSec)}s`;
		case 'nosignal':
			return 'Signal lost — check electrode';
		case 'rate-too-low':
			return 'Sample rate too low for focus';
		case 'connecting':
			return 'Connecting…';
		case 'offline':
			return '';
	}
}
