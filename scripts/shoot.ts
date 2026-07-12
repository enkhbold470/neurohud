// Capture the README images by driving the REAL overlay through the REAL relay.
//
// Nothing here is a mockup. The pixels come from `src/overlay/`, the states come from
// `deriveTelemetry()`, and the relay is the same `server.ts` a streamer runs. What IS synthetic
// is the input: these are generated telemetry values, not a capture from a person wearing the
// headset. The README says exactly that, in those words. These images must never imply otherwise.
//
//   bun run shoot        → docs/*.png + docs/overlay.gif
//
// No ffmpeg, no native deps — the GIF is quantised and encoded in pure JS, so anyone who clones
// this can regenerate the README assets with nothing but `bun install`.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { PNG } from 'pngjs';
import { chromium, type Page } from 'playwright';

import { generateToken } from '../src/lib/security';
import { deriveTelemetry, type LinkSnapshot, type Telemetry } from '../src/lib/wire';

const PORT = 8801;
const ROOT = join(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');

/**
 * A synthetic backdrop that runs from blown-out highlight to near-black across the width of the
 * panel. The overlay has to stay legible over ALL of it — which is exactly why it carries a
 * blurred scrim *and* a drop shadow *and* a hairline edge. Any one of the three alone fails at
 * one end of this gradient, and a real game will put both ends behind the overlay eventually.
 */
const scene = (w: number, h: number, pad: string) => `
	html, body { overflow: visible !important; }
	body {
		background:
			radial-gradient(420px 300px at 22% 26%, rgba(255,255,255,.55), transparent 70%),
			radial-gradient(520px 380px at 78% 76%, rgba(150,40,20,.35), transparent 72%),
			linear-gradient(108deg,
				#f4f8fb 0%, #cbdae5 14%, #7f9fb8 30%,
				#41627e 48%, #22384c 64%, #14202c 80%, #05070b 100%) !important;
		width: ${w}px; height: ${h}px; padding: ${pad};
	}
`;

function metrics(over: Record<string, unknown> = {}) {
	return {
		engagement: 1.4,
		focus: 72,
		calm: 31,
		blinks: 6,
		bands: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 0.5 },
		alphaPeak: 10.2,
		rmsUv: 14,
		signalOk: true,
		warmingUp: false,
		calibrating: false,
		calibrationLeftSec: 0,
		baseline: 1.1,
		fsOk: true,
		fsReason: null,
		...over
	} as LinkSnapshot['metrics'];
}

const tel = (over: Partial<LinkSnapshot> = {}): Telemetry =>
	deriveTelemetry({
		linkState: 'live',
		metrics: metrics(),
		device: 'NEUROFOCUS_V4_headphone',
		fs: 175,
		at: Date.now(),
		...over
	});

// ── boot a relay we own ────────────────────────────────────────────────────────────────

// Mint a throwaway token and hand it to the server, rather than depending on a `state/token`
// that a fresh clone does not have yet.
const token = generateToken();
const server = spawn('bun', ['run', 'server.ts'], {
	cwd: ROOT,
	env: { ...process.env, NEUROHUD_PORT: String(PORT), NEUROHUD_TOKEN: token, NEUROHUD_NO_OPEN: '1' },
	stdio: 'ignore'
});
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 }); // retina — these land in a README
await mkdir(DOCS, { recursive: true });

/** Holds the source socket, so the relay sees a loopback Origin exactly as a real link page does. */
const source = await ctx.newPage();
await source.goto(`http://127.0.0.1:${PORT}/health`);
await source.evaluate(
	([tk, p]) =>
		new Promise<void>((resolve) => {
			const ws = new WebSocket(`ws://127.0.0.1:${p}/ws?role=source&t=${tk}`);
			(window as never as { ws: WebSocket }).ws = ws;
			ws.onopen = () => resolve();
		}),
	[token, String(PORT)] as const
);

const push = async (t: Telemetry, settle = 400): Promise<void> => {
	await source.evaluate(
		(payload) => (window as never as { ws: WebSocket }).ws.send(payload),
		JSON.stringify(t)
	);
	await new Promise((r) => setTimeout(r, settle));
};

async function overlayPage(w: number, h: number, pad: string): Promise<Page> {
	const page = await ctx.newPage();
	await page.setViewportSize({ width: w, height: h });
	await page.goto(`http://127.0.0.1:${PORT}/overlay?t=${token}`);
	await page.addStyleTag({ content: scene(w, h, pad) });
	await page.waitForTimeout(700);
	return page;
}

/** Clip to the panel itself plus a little scene around it — no dead space in a README image. */
async function shotOfPanel(page: Page, margin = 22): Promise<Buffer> {
	const box = await page.locator('#panel').boundingBox();
	if (!box) throw new Error('panel not rendered');
	return page.screenshot({
		clip: {
			x: box.x - margin,
			y: box.y - margin,
			width: box.width + margin * 2,
			height: box.height + margin * 2
		}
	});
}

// ── 01 · the hero: what a stream frame actually looks like ─────────────────────────────
const hero = await overlayPage(1080, 300, '34px 0 0 34px');
await push(tel({ metrics: metrics({ focus: 78, calm: 26 }) }));
await hero.screenshot({ path: join(DOCS, '01-live.png') });
console.log('  docs/01-live.png');
await hero.close();

// The panel-only page, used for the refusals.
const page = await overlayPage(500, 300, '24px 0 0 24px');

// ── 02 · the three refusals ────────────────────────────────────────────────────────────
// Each is a state the overlay can genuinely reach mid-stream, and in every one of them there is
// no number on screen — only the reason there isn't.
const refusals: [string, Telemetry][] = [
	['calibrating', tel({ metrics: metrics({ calibrating: true, calibrationLeftSec: 12 }) })],
	['nosignal', tel({ metrics: metrics({ signalOk: false, focus: 99 }) })],
	[
		'rate',
		tel({
			fs: 90,
			metrics: metrics({
				fsOk: false,
				fsReason: '60 Hz mains folds to 30.0 Hz at 90 SPS and cannot be notched'
			})
		})
	]
];

const refusalShots: Buffer[] = [];
for (const [, t] of refusals) {
	await push(t);
	refusalShots.push(await shotOfPanel(page));
}
await writeFile(join(DOCS, '02-refusals.png'), vstack(refusalShots));
console.log('  docs/02-refusals.png');

// ── 03 · the link page — the control room ──────────────────────────────────────────────
const link = await ctx.newPage();
await link.setViewportSize({ width: 840, height: 1200 });
await link.goto(`http://127.0.0.1:${PORT}/link?t=${token}`);
await push(tel({ metrics: metrics({ focus: 78, calm: 26 }) }));
await link.waitForTimeout(1000);
await link.screenshot({ path: join(DOCS, '03-link.png'), fullPage: true });
console.log('  docs/03-link.png');
await link.close();

// ── the GIF · a stream's worth of states in eight seconds ──────────────────────────────
// calibrate → live → climb into flow → the electrode pops off → the tab dies → dark.
const script: Telemetry[] = [];
for (let i = 10; i > 0; i--) {
	script.push(tel({ metrics: metrics({ calibrating: true, calibrationLeftSec: i }) }));
}
// A deterministic focus walk, so re-shooting produces the same clip.
const walk = [44, 47, 52, 49, 55, 58, 61, 57, 63, 68, 72, 76, 79, 83, 81, 77, 73, 69, 64, 60];
for (const f of walk) script.push(tel({ metrics: metrics({ focus: f, calm: 96 - f * 0.7 }) }));
for (let i = 0; i < 7; i++) script.push(tel({ metrics: metrics({ signalOk: false, focus: 99 }) }));
for (let i = 0; i < 6; i++) script.push(tel({ linkState: 'idle', metrics: null }));

// The GIF renders at 1x. At retina it lands ~2.3 MB, which is a rude thing to put in a README.
const gifCtx = await browser.newContext({ deviceScaleFactor: 1 });
const gifPage = await gifCtx.newPage();
await gifPage.setViewportSize({ width: 500, height: 300 });
await gifPage.goto(`http://127.0.0.1:${PORT}/overlay?t=${token}`);
await gifPage.addStyleTag({ content: scene(500, 300, '24px 0 0 24px') });
await gifPage.waitForTimeout(700);

// Every frame must be identically sized, but the panel grows when a reason line appears.
// Measure the tallest state once, and pin the clip to it.
await push(tel({ metrics: metrics({ signalOk: false }) }));
const tall = await gifPage.locator('#panel').boundingBox();
if (!tall) throw new Error('panel not rendered');
const M = 22;
const CLIP = {
	x: tall.x - M,
	y: tall.y - M,
	width: tall.width + M * 2,
	height: tall.height + M * 2
};

const gif = GIFEncoder();
for (const t of script) {
	await push(t, 120);
	const { data, width, height } = decode(await gifPage.screenshot({ clip: CLIP }));
	// A fresh 256-colour palette per frame: the scrim is a smooth gradient, and one global
	// palette bands it visibly.
	const palette = quantize(data, 256, { format: 'rgb565' });
	gif.writeFrame(applyPalette(data, palette, 'rgb565'), width, height, {
		palette,
		delay: 120,
		transparent: false
	});
}
gif.finish();
await writeFile(join(DOCS, 'overlay.gif'), Buffer.from(gif.bytes()));
console.log(`  docs/overlay.gif  (${script.length} frames)`);

await browser.close();
server.kill();
console.log('\n✓ shot.');

// ── pure-JS image helpers, so this needs no ffmpeg ─────────────────────────────────────

function decode(buf: Buffer): { data: Uint8Array; width: number; height: number } {
	const png = PNG.sync.read(buf);
	return { data: new Uint8Array(png.data), width: png.width, height: png.height };
}

/** Stack PNGs vertically into one. Replaces `ffmpeg -filter_complex vstack`. */
function vstack(buffers: Buffer[]): Buffer {
	const pngs = buffers.map((b) => PNG.sync.read(b));
	const width = Math.max(...pngs.map((p) => p.width));
	const height = pngs.reduce((sum, p) => sum + p.height, 0);
	const out = new PNG({ width, height });

	let y = 0;
	for (const p of pngs) {
		PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, y);
		y += p.height;
	}
	return PNG.sync.write(out);
}
