// Drives the real overlay in a real browser against the real relay.
//
// The unit tests prove `wire.ts` withholds a number when a gate is shut. These prove the thing
// that actually matters to a streamer: that the pixels OBS composites onto a live broadcast
// never show a number the signal did not earn — including when the link dies mid-stream and
// nobody is left to say so.

import { expect, test, type Page } from '@playwright/test';

import { PORT, TOKEN } from '../playwright.config';
import { deriveTelemetry, type LinkSnapshot, type Telemetry } from '../src/lib/wire';

/** A FocusMetrics with every gate open; each test closes exactly one. */
function metrics(over: Record<string, unknown> = {}) {
	return {
		engagement: 1.4,
		focus: 72,
		calm: 31,
		blinks: 4,
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

function telemetry(over: Partial<LinkSnapshot> = {}): Telemetry {
	return deriveTelemetry({
		linkState: 'live',
		metrics: metrics(),
		device: 'NEUROFOCUS_V4_headphone',
		fs: 175,
		at: Date.now(),
		...over
	});
}

/**
 * Open the overlay and attach a fake source to the relay, exactly as the Chrome link page would.
 * Returns a `push` that drives the overlay from the test.
 */
async function openOverlay(page: Page, query = '') {
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(String(e)));

	await page.goto(`/overlay?t=${TOKEN}${query}`);

	// A second page acts as the source. It has to be a page (not a Node socket) so the relay
	// sees a loopback Origin, which is the whole point of the origin pinning.
	const source = await page.context().newPage();
	await source.goto(`/health`);
	await source.evaluate(
		([token, port]) =>
			new Promise<void>((resolve) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=source&t=${token}`);
				(window as never as { ws: WebSocket }).ws = ws;
				ws.onopen = () => resolve();
			}),
		[TOKEN, String(PORT)] as const
	);

	const push = async (t: Telemetry) => {
		await source.evaluate(
			(payload) => (window as never as { ws: WebSocket }).ws.send(payload),
			JSON.stringify(t)
		);
		await page.waitForTimeout(120);
	};

	return { push, source, errors };
}

const focusValue = (page: Page) => page.locator('#focus-row .value');
const calmValue = (page: Page) => page.locator('#calm-row .value');
const panel = (page: Page) => page.locator('#panel');

test('renders a number when every gate is open', async ({ page }) => {
	const { push, errors } = await openOverlay(page);
	await push(telemetry());

	await expect(focusValue(page)).toHaveText('72');
	await expect(calmValue(page)).toHaveText('31');
	await expect(panel(page)).toHaveAttribute('data-state', 'live');
	await expect(panel(page)).toHaveAttribute('data-nodata', '0');
	expect(errors).toEqual([]);
});

test('shows NO number while calibrating', async ({ page }) => {
	const { push } = await openOverlay(page);
	await push(telemetry({ metrics: metrics({ calibrating: true, calibrationLeftSec: 12 }) }));

	// The engine's own `focus` is 0 mid-calibration. A renderer that trusted it would print "0",
	// which is a claim about the streamer. There must be no digit on screen at all.
	await expect(focusValue(page)).toHaveText('—');
	await expect(calmValue(page)).toHaveText('—');
	await expect(panel(page)).toHaveAttribute('data-state', 'calibrating');
	await expect(page.locator('#status')).toContainText('calibrating');
});

test('shows NO number when the electrode is detached', async ({ page }) => {
	const { push } = await openOverlay(page);
	// A detached electrode collapses alpha+theta and the raw ratio reads as perfect focus.
	await push(telemetry({ metrics: metrics({ signalOk: false, focus: 99 }) }));

	await expect(focusValue(page)).toHaveText('—');
	await expect(panel(page)).toHaveAttribute('data-state', 'nosignal');
	await expect(page.locator('#reason')).toContainText('Electrode not reading');
	// The "99" must appear nowhere on the page.
	await expect(page.locator('#panel')).not.toContainText('99');
});

test('shows NO number, and says why, when the sample rate cannot carry the score', async ({
	page
}) => {
	const { push } = await openOverlay(page);
	await push(
		telemetry({
			fs: 90,
			metrics: metrics({
				fsOk: false,
				fsReason: '60 Hz mains folds to 30.0 Hz at 90 SPS and cannot be notched'
			})
		})
	);

	await expect(focusValue(page)).toHaveText('—');
	await expect(panel(page)).toHaveAttribute('data-state', 'rate-too-low');
	await expect(page.locator('#reason')).toContainText('mains folds to 30.0 Hz');
});

test('goes dark when the link dies — a frozen number is a lie', async ({ page }) => {
	const { push, source } = await openOverlay(page);
	await push(telemetry());
	await expect(focusValue(page)).toHaveText('72');

	// The Chrome tab crashes. Nobody sends a goodbye. The last good number would otherwise sit
	// on the broadcast, looking healthy, for as long as the stream runs.
	await source.close();

	await expect(panel(page)).toHaveAttribute('data-state', 'offline', { timeout: 6000 });
	await expect(panel(page)).not.toHaveClass(/visible/);
	await expect(focusValue(page)).toHaveText('—');
});

test('flags flow above the threshold', async ({ page }) => {
	const { push } = await openOverlay(page);
	await push(telemetry({ metrics: metrics({ focus: 81 }) }));
	await expect(panel(page)).toHaveClass(/flow/);
	await expect(page.locator('#status')).toContainText('in flow');

	await push(telemetry({ metrics: metrics({ focus: 44 }) }));
	await expect(panel(page)).not.toHaveClass(/flow/);
});

test('always carries the honesty footer', async ({ page }) => {
	const { push } = await openOverlay(page);
	await push(telemetry());
	const footer = page.locator('#footer');
	await expect(footer).toContainText('baseline');
	await expect(footer).toContainText('around-ear');
	// An earpad electrode is around-ear. It is not Fp1, frontal, or prefrontal.
	await expect(footer).not.toContainText(/fp1|frontal|prefrontal/i);
});

test('shows a SIM badge for synthetic telemetry, and no badge for real', async ({ page }) => {
	const { push } = await openOverlay(page);

	await push(telemetry());
	await expect(page.locator('#sim')).toBeHidden();

	await push(telemetry({ sim: true }));
	await expect(page.locator('#sim')).toBeVisible();
	await expect(page.locator('#sim')).toHaveText('SIM');
	// The number still renders — the point is that it renders LABELLED, not that it is withheld.
	await expect(focusValue(page)).toHaveText('72');
});

test('the SIM badge cannot be turned off by a query param', async ({ page }) => {
	// Someone will try. The harness can drive the overlay that goes on a live broadcast, so this
	// badge is the only thing standing between a synthetic score and an audience believing it.
	const { push } = await openOverlay(page, '&sim=0&bars=0&theme=light&scale=1');
	await push(telemetry({ sim: true }));
	await expect(page.locator('#sim')).toBeVisible();
});

test('the overlay refuses to load telemetry without a token', async ({ page }) => {
	// The attack: a page the streamer has open in another tab opens a socket to the relay.
	// WebSockets get no CORS preflight, so nothing but our own check stops this.
	await page.goto(`/overlay?t=${TOKEN}`);
	const refused = await page.evaluate(
		(port) =>
			new Promise<string>((resolve) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=source&t=not-the-token`);
				ws.onopen = () => resolve('OPENED');
				ws.onerror = () => resolve('refused');
				ws.onclose = () => resolve('refused');
			}),
		String(PORT)
	);
	expect(refused).toBe('refused');
});
