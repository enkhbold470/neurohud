# NeuroHUD — design

**Date:** 2026-07-12
**Status:** implemented. Kept as the record of *why* the pieces are shaped this way.

> Written before the security layer existed. Everything below still holds, with one addition: the
> relay is authenticated (loopback bind + Origin/Host pinning + a generated bearer token), because
> a localhost WebSocket gets no CORS preflight and would otherwise let any site you have open push
> fabricated numbers onto your live stream. See `src/lib/security.ts` and the README.

## What this is

A way to put a NeuroFocus wearer's live focus score on a gaming stream — OBS, Streamlabs,
XSplit, vMix, anything with a browser source.

`neurohud` is a small standalone Bun project: a **relay server**, a **link page** you open in
Chrome, and an **overlay page** you paste into OBS as a Browser Source.

## Why it is shaped this way

**OBS's browser source has no Web Bluetooth.** It runs in OBS's own embedded Chromium (CEF),
built without the Bluetooth backend, and Web Bluetooth additionally needs a user gesture and a
device chooser that a background browser source cannot present. So the device link cannot live
in OBS. It has to live in a real Chrome tab, and the numbers have to cross a process boundary
to reach OBS.

That boundary is the relay:

```
Chrome tab (/link)                 nf-obs server              OBS / Streamlabs / vMix
──────────────────                 ─────────────              ───────────────────────
Web Bluetooth ─┐
NeuroLink      │   WS push        ┌────────────┐    WS       ┌────────────────┐
FocusEngine  ──┴─────────────────▶│   relay    │────────────▶│ Browser Source │
                  (~10 Hz)        │ last-value │             │   /overlay     │
                                  └────────────┘             └────────────────┘
                                        │
                                        ├── GET /state.json   (bots, Streamer.bot)
                                        └── state/focus.txt   (OBS Text → read from file)
```

Rejected alternatives: talking to OBS's own obs-websocket straight from Chrome (OBS-only, needs
a password, and can only drive text sources — no bars, no transparency); and a native C++ OBS
plugin (would mean reimplementing the DSP in C++, cross-platform build pain, and breakage on
every OBS release, for no gain a browser source doesn't already give us).

## The number we do not ship

**There is no stress metric, and we are not inventing one.**

A single around-ear channel cannot support a psychological stress claim. `focus.ts` exports
exactly two numbers, and we ship exactly those two:

- **Focus** — the Pope et al. (1995) engagement index, `β/(α+θ)`, mapped to 0–100 by a logistic
  against the wearer's own baseline, frozen after the first 20 s. 50 means *their own* baseline.
  Not comparable between people, and only meaningful within one session.
- **Calm** — alpha share of `θ+α+β`. A relaxation cue. **It is not `100 − focus`.**

The word "stress" does not appear in the overlay, the link page, or the wire payload.

## The honesty gate — the core design decision

The overlay is pointed at an audience. A wrong number on stream is worse than no number, and
this signal has three well-understood ways of lying:

- a detached electrode collapses `α+θ` to the noise floor, and the ungated ratio then reads as
  flawless concentration;
- below 175 SPS the score is not defensible at all (β sits above the passband, and 60 Hz mains
  aliases *into* β, where mains hum reads as concentration);
- before the baseline is frozen, the score has no referent.

`focus.ts` already exposes `signalOk`, `calibrating` and `fsOk` for exactly this. The design
decision is **where** they get enforced:

> **`focus` and `calm` are `null` on the wire unless `signalOk && !calibrating && fsOk`.**

The gate lives in `wire.ts`, at the serialisation boundary — not in the renderer. The overlay
therefore *cannot* render a number when the signal doesn't deserve one, because there is no
number to render. A renderer bug cannot leak a fabricated score to an audience.

A fourth way of lying is unique to streaming and has no counterpart in the analyzer: **stale
data**. If the Chrome tab crashes, the last good number would otherwise sit frozen on stream
looking perfectly healthy. So the overlay runs a staleness watchdog — no telemetry for 3 s and
it fades out.

## Components

### `src/lib/` — vendored, do not edit

`ble.ts`, `dsp.ts`, `focus.ts`, `adc.ts` and their test suites, copied **byte-identical** from
`web-ble-monitor`. Byte-identical is what makes the drift guard mean something:

- `bun run sync:lib` re-copies from `../web-ble-monitor/src/lib/`.
- `bun run check:lib` diffs and **fails** if they have drifted. Runs in CI and before build.
- The vendored vitest suites run as-is, so a bad sync breaks the build rather than the science.

nf-obs stays independently clonable, which is how the other five repos already work.

### `src/lib/wire.ts` — new, owned by nf-obs

The contract between link and overlay, and the only place the honesty gate is applied.

```ts
export type StreamState =
  | 'offline'          // no source connected
  | 'connecting'
  | 'calibrating'      // baseline not yet frozen
  | 'live'
  | 'nosignal'         // electrode detached / flat trace
  | 'rate-too-low';    // fs cannot carry the Pope index

export interface Telemetry {
  v: 1;
  t: number;                    // epoch ms, when sampled
  state: StreamState;
  focus: number | null;         // 0–100. null unless state === 'live'
  calm: number | null;          // 0–100. null unless state === 'live'
  flow: boolean;                // focus >= FLOW_THRESHOLD (60)
  blinks: number;
  calibrationLeftSec: number;
  fs: number | null;
  fsReason: string | null;      // why the rate is unusable, when it is
  device: string | null;
  baseline: number | null;
}
```

`deriveTelemetry(metrics, linkState, deviceName, fs)` is a pure function — fully unit-testable,
no BLE, no DOM. It is where the three gates collapse into one `state`.

### `server.ts` — the relay

`Bun.serve`, no dependencies.

- `GET /link` → the Chrome page
- `GET /overlay` → the OBS page
- `WS /ws?role=source` → the link page pushes telemetry (~10 Hz)
- `WS /ws?role=view` → the overlay (and anything else) receives it
- `GET /state.json` → the last telemetry, for bots and Streamer.bot
- `state/focus.txt` → written ~2 Hz, for an OBS **Text (GDI+) → read from file** source, so a
  streamer who wants no graphics at all still has a path

A new viewer is sent the last-known telemetry immediately on connect, so switching to the scene
in OBS shows state at once instead of a blank box.

The board accepts one BLE central, so the relay accepts one `source`: a second `/link` takes
over and the first is told to stand down.

On startup the server prints the overlay URL, ready to paste into OBS.

### `src/link/` — the Chrome page

Connect button, live readout, and everything the streamer needs to set up *before* going live:

- calibration countdown (20 s, frozen after)
- signal quality + a DIAG button
- sample rate selector, surfacing `focusFeasibility` — **focus needs ≥ 175 SPS**
- mains 50/60 (defaults to 60; do not "correct" it for North America)
- baseline persisted to `localStorage`, so a returning streamer doesn't recalibrate every stream
  (`FocusEngine` already accepts `baselineEngagement`)
- a copy-to-clipboard button for the overlay URL
- plain text, stated once, where the streamer will see it: **clenching your jaw raises the focus
  score exactly like concentrating does.** One channel cannot separate them.

### `src/overlay/` — the OBS page

Transparent background. Renders per state, and *only* per state:

| state | renders |
|---|---|
| `live` | FOCUS bar + number, CALM bar + number; flow glow at ≥ 60 |
| `calibrating` | `CALIBRATING · 12s` — never a number |
| `nosignal` | `SIGNAL LOST — check electrode` — never a number |
| `rate-too-low` | `RATE TOO LOW FOR FOCUS` + the reason |
| `offline` | fades out entirely |

Footer, always: *relative to my own baseline · single around-ear channel*.

Query params for the streamer: `?theme=dark|light`, `?bars=1|0`, `?scale=1.5`.

## Testing

- The vendored suites run unmodified — a drifted copy fails the build.
- `wire.test.ts` — the gate, which is the thing most worth protecting: a detached electrode
  yields `focus: null`; mid-calibration yields `null`; 90 SPS yields `null` plus a reason; a good
  live signal yields a number.
- `server.test.ts` — fan-out, last-value replay to a fresh viewer, source takeover.
- Playwright against `/overlay`: feed synthetic telemetry over the WS and assert no console
  errors, assert **no number is rendered while calibrating**, and assert the overlay goes blank
  when the source stops.

## Out of scope

No stress metric. No native OBS plugin. No cloud relay — the server is localhost-only; EEG stays
on the streamer's machine. No dota2-companion coupling (that repo builds against an abstract
`EEGSource` on purpose, and this does not change it).
