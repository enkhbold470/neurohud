import { describe, expect, it } from 'vitest';

import { ADC_PROFILES } from './adc';
import { FLOW_THRESHOLD, FocusEngine } from './focus';
import {
	OVERLAY_FOOTER,
	STALE_AFTER_MS,
	deriveTelemetry,
	formatTextLine,
	isStale,
	offlineTelemetry,
	type LinkSnapshot
} from './wire';

const FS = 175; // firmware v4's real ADS1220 rate — the lowest rate the Pope index survives
const T = 1_752_300_000_000; // fixed epoch, so nothing here depends on the clock

/** A FocusMetrics with every gate open. Individual tests close one gate at a time. */
function goodMetrics(over: Partial<ReturnType<FocusEngine['read']>> = {}) {
	return {
		engagement: 1.4,
		focus: 72,
		calm: 31,
		blinks: 3,
		bands: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 0.5 },
		alphaPeak: 10.2,
		rmsUv: 12,
		signalOk: true,
		warmingUp: false,
		calibrating: false,
		calibrationLeftSec: 0,
		baseline: 1.1,
		fsOk: true,
		fsReason: null,
		...over
	};
}

function snapshot(over: Partial<LinkSnapshot> = {}): LinkSnapshot {
	return {
		linkState: 'live',
		metrics: goodMetrics(),
		device: 'NEUROFOCUS_V4_headphone',
		fs: FS,
		at: T,
		...over
	};
}

describe('deriveTelemetry — the honesty gate', () => {
	it('passes a number through only when signal, calibration and rate are all good', () => {
		const t = deriveTelemetry(snapshot());
		expect(t.state).toBe('live');
		expect(t.focus).toBe(72);
		expect(t.calm).toBe(31);
		expect(t.fs).toBe(FS);
		expect(t.device).toBe('NEUROFOCUS_V4_headphone');
	});

	it('withholds the number while the electrode is detached', () => {
		// The failure this exists to prevent: a detached electrode collapses alpha+theta to the
		// noise floor, so the ungated ratio explodes and reads as flawless concentration.
		const t = deriveTelemetry(snapshot({ metrics: goodMetrics({ signalOk: false, focus: 99 }) }));
		expect(t.state).toBe('nosignal');
		expect(t.focus).toBeNull();
		expect(t.calm).toBeNull();
		expect(t.flow).toBe(false);
	});

	it('withholds the number while calibrating, and reports the countdown', () => {
		const t = deriveTelemetry(
			snapshot({ metrics: goodMetrics({ calibrating: true, calibrationLeftSec: 12.5, focus: 0 }) })
		);
		expect(t.state).toBe('calibrating');
		expect(t.focus).toBeNull();
		expect(t.calibrationLeftSec).toBe(12.5);
	});

	it('withholds the number when the sample rate cannot carry the Pope index', () => {
		// At 90 SPS, 60 Hz mains folds to 30 Hz — directly inside beta, the focus numerator.
		// Mains hum would read as concentration.
		const t = deriveTelemetry(
			snapshot({
				fs: 90,
				metrics: goodMetrics({ fsOk: false, fsReason: '60 Hz mains folds to 30.0 Hz at 90 SPS' })
			})
		);
		expect(t.state).toBe('rate-too-low');
		expect(t.focus).toBeNull();
		expect(t.fsReason).toMatch(/mains folds/);
	});

	it('reports the rate problem ahead of the signal problem — the rate is the hard blocker', () => {
		// Both gates shut. Fixing the electrode still leaves no usable score, so the rate is the
		// message the streamer actually needs.
		const t = deriveTelemetry(
			snapshot({
				fs: 90,
				metrics: goodMetrics({ fsOk: false, fsReason: 'rate', signalOk: false })
			})
		);
		expect(t.state).toBe('rate-too-low');
		expect(t.focus).toBeNull();
	});

	it('withholds the number before the link is live', () => {
		for (const linkState of ['idle', 'requesting', 'connecting', 'reconnecting', 'error'] as const) {
			const t = deriveTelemetry(snapshot({ linkState }));
			expect(t.focus, linkState).toBeNull();
			expect(t.state, linkState).not.toBe('live');
		}
	});

	it('withholds the number while the analysis window is still filling', () => {
		const t = deriveTelemetry(snapshot({ metrics: goodMetrics({ warmingUp: true }) }));
		expect(t.state).toBe('connecting');
		expect(t.focus).toBeNull();
	});

	it('withholds the number when there are no metrics at all', () => {
		const t = deriveTelemetry(snapshot({ metrics: null }));
		expect(t.focus).toBeNull();
		expect(t.state).toBe('connecting');
	});

	it('never emits "stress" — the payload carries focus and calm only', () => {
		const keys = Object.keys(deriveTelemetry(snapshot()));
		expect(keys).not.toContain('stress');
		expect(JSON.stringify(deriveTelemetry(snapshot())).toLowerCase()).not.toContain('stress');
	});

	it('flags flow at and above the threshold, never below', () => {
		expect(deriveTelemetry(snapshot({ metrics: goodMetrics({ focus: FLOW_THRESHOLD }) })).flow).toBe(
			true
		);
		expect(
			deriveTelemetry(snapshot({ metrics: goodMetrics({ focus: FLOW_THRESHOLD - 0.1 }) })).flow
		).toBe(false);
	});

	it('rounds to one decimal so the overlay does not jitter on noise', () => {
		const t = deriveTelemetry(snapshot({ metrics: goodMetrics({ focus: 72.4444, calm: 31.9876 }) }));
		expect(t.focus).toBe(72.4);
		expect(t.calm).toBe(32);
	});
});

describe('deriveTelemetry — against a real FocusEngine', () => {
	/** Feed `sec` seconds of a sum of sinusoids, sample by sample, in µV. */
	function feed(engine: FocusEngine, parts: [freq: number, amp: number][], sec: number): void {
		const n = Math.round(FS * sec);
		for (let i = 0; i < n; i++) {
			let v = 0;
			for (const [f, a] of parts) v += a * Math.sin((2 * Math.PI * f * i) / FS);
			engine.push(v);
		}
	}

	it('reports nosignal for a flat trace — nothing connected', () => {
		const engine = new FocusEngine(FS);
		feed(engine, [[10, 0.01]], 6); // essentially the ADC noise floor
		const t = deriveTelemetry(snapshot({ metrics: engine.read(), fs: FS }));
		expect(t.state).toBe('nosignal');
		expect(t.focus).toBeNull();
	});

	it('calibrates, then goes live with a real number', () => {
		// A known baseline skips the 20 s calibration — the same door `FocusEngine` opens for a
		// returning streamer who does not want to recalibrate every stream.
		const engine = new FocusEngine(FS, { baselineEngagement: 0.5 });
		feed(
			engine,
			[
				[10, 20], // alpha
				[20, 20] // beta
			],
			6
		);
		const t = deriveTelemetry(snapshot({ metrics: engine.read(), fs: FS }));
		expect(t.state).toBe('live');
		expect(t.focus).not.toBeNull();
		expect(t.focus!).toBeGreaterThanOrEqual(0);
		expect(t.focus!).toBeLessThanOrEqual(100);
		expect(t.baseline).toBe(0.5);
	});

	it('refuses a number at 90 SPS even with a textbook signal', () => {
		const engine = new FocusEngine(90, { baselineEngagement: 0.5 });
		for (let i = 0; i < 90 * 6; i++) {
			engine.push(20 * Math.sin((2 * Math.PI * 10 * i) / 90) + 20 * Math.sin((2 * Math.PI * 20 * i) / 90));
		}
		const t = deriveTelemetry(snapshot({ metrics: engine.read(), fs: 90 }));
		expect(t.state).toBe('rate-too-low');
		expect(t.focus).toBeNull();
	});
});

describe('staleness — a frozen number on stream is a lie', () => {
	it('treats telemetry older than the window as stale', () => {
		const t = deriveTelemetry(snapshot({ at: T }));
		expect(isStale(t, T)).toBe(false);
		expect(isStale(t, T + STALE_AFTER_MS - 1)).toBe(false);
		expect(isStale(t, T + STALE_AFTER_MS + 1)).toBe(true);
	});

	it('offlineTelemetry carries no number', () => {
		const t = offlineTelemetry(T);
		expect(t.state).toBe('offline');
		expect(t.focus).toBeNull();
		expect(t.calm).toBeNull();
		expect(t.flow).toBe(false);
	});
});

describe('formatTextLine — the OBS text-source fallback', () => {
	it('shows both numbers when live', () => {
		expect(formatTextLine(deriveTelemetry(snapshot()))).toBe('Focus 72  ·  Calm 31');
	});

	it('shows the reason, not a number, when a gate is shut', () => {
		expect(
			formatTextLine(
				deriveTelemetry(snapshot({ metrics: goodMetrics({ calibrating: true, calibrationLeftSec: 9 }) }))
			)
		).toBe('Calibrating… 9s');
		expect(
			formatTextLine(deriveTelemetry(snapshot({ metrics: goodMetrics({ signalOk: false }) })))
		).toBe('Signal lost — check electrode');
		expect(formatTextLine(offlineTelemetry(T))).toBe('');
	});
});

describe('the SIM flag — a synthetic number must never pass as a measured one', () => {
	it('defaults to false: a real headset is never tagged sim', () => {
		expect(deriveTelemetry(snapshot()).sim).toBe(false);
		expect(offlineTelemetry(T).sim).toBe(false);
	});

	it('is carried on every frame the harness sends, in every state', () => {
		expect(deriveTelemetry(snapshot({ sim: true })).sim).toBe(true);
		expect(deriveTelemetry(snapshot({ sim: true, linkState: 'idle' })).sim).toBe(true);
		expect(
			deriveTelemetry(snapshot({ sim: true, metrics: goodMetrics({ signalOk: false }) })).sim
		).toBe(true);
	});

	it('marks the OBS text-source line too, where there is even less room for context', () => {
		expect(formatTextLine(deriveTelemetry(snapshot({ sim: true })))).toBe(
			'SIM · Focus 72  ·  Calm 31'
		);
		expect(formatTextLine(deriveTelemetry(snapshot()))).not.toMatch(/SIM/);
	});
});

describe('the claims we must not drift on', () => {
	it('the footer names the baseline and the electrode honestly', () => {
		expect(OVERLAY_FOOTER).toMatch(/baseline/i);
		expect(OVERLAY_FOOTER).toMatch(/around-ear/i);
		// An earpad electrode is around-ear. It is not Fp1, frontal, or prefrontal.
		expect(OVERLAY_FOOTER).not.toMatch(/fp1|frontal|prefrontal/i);
	});
});
