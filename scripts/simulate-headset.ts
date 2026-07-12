// A synthetic headset, for testing the pipeline without hardware.
//
//   bun run sim              # a plausible session: calibrate, focus, drift, clench, unplug
//   bun run sim --fs 90      # prove the rate gate refuses to score
//
// ## What this is NOT
//
// This is **not a demo mode**, and it must never become one. It is a dev harness: it generates
// EEG-shaped µV, converts them to ADC counts with the real v4 profile, and pushes them through
// the **real `FocusEngine`** and the **real `deriveTelemetry()` gate**. Everything downstream of
// the radio is genuine — the filters, the Welch PSD, the Pope index, the frozen baseline, and
// every one of the three refusals. Only the electrode is fake.
//
// And because it drives the same overlay that can go on a live broadcast, every frame it sends
// carries `sim: true`, which the overlay renders as a non-suppressible `SIM` badge. A synthetic
// number an audience mistakes for a measured one is the exact thing this codebase refuses; that
// it would be our own harness doing the lying makes it worse, not better.

import { ADC_PROFILES } from '../src/lib/adc';
import { RATE_LADDER } from '../src/lib/ble';
import { FocusEngine } from '../src/lib/focus';
import { loadConfig } from '../src/lib/config';
import { deriveTelemetry } from '../src/lib/wire';

const cfg = loadConfig();

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
};

const fs = Number(argOf('--fs') ?? 175);
if (!RATE_LADDER.includes(fs as (typeof RATE_LADDER)[number])) {
	console.error(`--fs must be one of the firmware's rates: ${RATE_LADDER.join(', ')}`);
	process.exit(1);
}

const SCALE = ADC_PROFILES.v4;
const PUSH_HZ = 10;

/** Invert `countsToUv` for the v4 profile, so we drive `pushCounts()` exactly as the radio does. */
function uvToCounts(uv: number): number {
	const halfScale = 2 ** (SCALE.adcBits - 1);
	return Math.round((uv * SCALE.gain * halfScale) / (SCALE.vref * 1e6));
}

// ── the session script ─────────────────────────────────────────────────────────────────
// Each phase shapes the synthetic EEG. Focus rises when beta grows relative to alpha+theta,
// which is what the Pope index actually measures — we are not writing a focus number directly,
// we are writing a *brain* and letting the real DSP decide what it means.

interface Phase {
	sec: number;
	label: string;
	/** µV amplitude per band, and whether the electrode is even attached. */
	theta: number;
	alpha: number;
	beta: number;
	attached: boolean;
}

// Engagement rises mostly through **alpha desynchronisation** — α and θ dropping — with only a
// modest β increase. That is the physiology, and it also keeps the score off the rails: an
// earlier version tripled β outright, drove E to 30x baseline, and pegged the logistic at a
// permanent, implausible 100. A demo that pegs is a demo nobody believes.
const SESSION: Phase[] = [
	{ sec: 24, label: 'calibrating — resting baseline', theta: 14, alpha: 18, beta: 7, attached: true },
	{ sec: 12, label: 'baseline frozen · idling', theta: 13, alpha: 17, beta: 7.2, attached: true },
	{ sec: 16, label: 'locking in — α desynchronising', theta: 12, alpha: 15, beta: 8, attached: true },
	{ sec: 16, label: 'in flow', theta: 10, alpha: 12, beta: 8.5, attached: true },
	{ sec: 12, label: 'drifting off', theta: 15, alpha: 20, beta: 6, attached: true },
	{ sec: 12, label: 'ELECTRODE DETACHED — watch the gate close', theta: 0, alpha: 0, beta: 0, attached: false }
];

const engine = new FocusEngine(fs, { line: 60 });

let phaseIdx = 0;
let phaseStartedAt = Date.now();
let n = 0;
let announced = '';

/** One sample of EEG-shaped µV for the current phase. */
function sample(p: Phase): number {
	if (!p.attached) {
		// A detached electrode is not silence — it is the ADC's own noise floor. This is the
		// input that makes an ungated beta/(alpha+theta) explode into "flawless concentration".
		return (Math.random() - 0.5) * 0.4;
	}
	const t = n / fs;
	const wobble = 1 + 0.12 * Math.sin(2 * Math.PI * 0.07 * t); // slow, brain-like drift
	return (
		p.theta * wobble * Math.sin(2 * Math.PI * 6 * t + 0.7) +
		p.alpha * wobble * Math.sin(2 * Math.PI * 10.2 * t) +
		p.beta * wobble * Math.sin(2 * Math.PI * 19 * t + 1.9) +
		(Math.random() - 0.5) * 6 + // broadband EEG noise
		1.2 * Math.sin(2 * Math.PI * 60 * t) // a little 60 Hz mains, for the notch to earn its keep
	);
}

const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?role=source&t=${cfg.token}`);

ws.addEventListener('error', () => {
	console.error(`\n  ✗ Could not reach the relay on port ${cfg.port}. Is \`bun start\` running?\n`);
	process.exit(1);
});

ws.addEventListener('open', () => {
	console.log(`
  ┌─ SYNTHETIC HEADSET ────────────────────────────────────────────────────
  │
  │  Not a demo mode. Synthetic µV → real ADC scaling → real FocusEngine
  │  → real gate. Only the electrode is fake.
  │
  │  Every frame is tagged sim:true, and the overlay shows a SIM badge.
  │  ${fs} SPS${fs < 175 ? '  ← below 175: the rate gate should REFUSE to score' : ''}
  │
  └────────────────────────────────────────────────────────────────────────
`);

	// Feed the DSP at the true sample rate, and push telemetry at 10 Hz — exactly as the link
	// page does when a real board is streaming.
	const samplesPerTick = Math.max(1, Math.round(fs / 50));
	setInterval(() => {
		const p = SESSION[Math.min(phaseIdx, SESSION.length - 1)]!;
		const counts: number[] = [];
		for (let i = 0; i < samplesPerTick; i++, n++) counts.push(uvToCounts(sample(p)));
		engine.pushCounts(counts, SCALE);

		if (Date.now() - phaseStartedAt > p.sec * 1000 && phaseIdx < SESSION.length - 1) {
			phaseIdx++;
			phaseStartedAt = Date.now();
		}
	}, 1000 / 50);

	setInterval(() => {
		const p = SESSION[Math.min(phaseIdx, SESSION.length - 1)]!;
		const t = deriveTelemetry({
			linkState: 'live',
			metrics: engine.read(),
			device: 'SIMULATED_HEADSET',
			fs,
			at: Date.now(),
			sim: true // ← the whole point. Never remove this.
		});
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(t));

		const line = `${p.label.padEnd(42)}  ${t.state.padEnd(13)}  focus ${
			t.focus === null ? '  —' : String(Math.round(t.focus)).padStart(3)
		}   calm ${t.calm === null ? '  —' : String(Math.round(t.calm)).padStart(3)}`;
		if (line !== announced) {
			console.log('  ' + line);
			announced = line;
		}
	}, 1000 / PUSH_HZ);
});
