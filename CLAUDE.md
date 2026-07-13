# CLAUDE.md — NeuroHUD

Live focus from a NeuroFocus dry-EEG headset, rendered as an OBS browser source.

Standalone repo. It does **not** depend on the other NeuroFocus repos at runtime — only
`bun run sync:lib` reaches across to a sibling `web-ble-monitor/` checkout, and it degrades to a
no-op when that isn't there.

```bash
bun install && bun start     # relay + link page + overlay
bun run test                 # drift check → unit → types → browser
bun run shoot                # regenerate docs/*.png and docs/overlay.gif
```

`bun run test`, never `bun test` — the latter is Bun's own runner and it collects the Playwright
specs in `tests/`, which it cannot run.

## The one rule

**The overlay is pointed at an audience.** Everything below follows from that.

A number that is wrong in a code review is a bug. A number that is wrong on a live stream is a
false claim about a person, made to their viewers, in their name. When those two goals conflict,
the second one wins.

## Locked invariants — do not drift, do not "improve"

- **`focus` and `calm` are `null` on the wire unless `signalOk && !calibrating && fsOk`.** The
  gate lives in `src/lib/wire.ts`, at the serialisation boundary — *not* in the renderer. That is
  deliberate: a renderer bug can then leak a layout mistake, but it cannot leak a fabricated
  score, because there is no number in the payload to draw. **Do not move this check into the
  overlay, and do not add a "raw" field that bypasses it.**
- **No-data must not look like zero.** Hatched track, em-dash. An empty bar reading `0` is a
  measurement claim; the absence of a reading is not. `#panel[data-nodata]` in
  `src/overlay/index.html`.
- **The staleness watchdog is load-bearing.** If the Chrome tab dies, nothing sends a goodbye —
  the socket just goes quiet while the last good number sits on the broadcast looking healthy.
  3 s of silence → the overlay fades out. Do not raise this timeout to "reduce flicker".
- **The metric is Pope et al. (1995) `β/(α+θ)`** (PMID 7647180), never `θ/β`. Unbounded, so it is
  mapped to 0–100 by a logistic against a per-user baseline **frozen after 20 s**. 50 means *your
  own* baseline. **Not comparable between people**, and only within a session.
- **There is no stress metric, and one must not be added.** A single around-ear channel cannot
  support that claim. `calm` is the α share — a relaxation cue, and explicitly **not**
  `100 - focus`.
- **The sensor is a single around-ear dry channel.** Never call it "Fp1", "frontal" or
  "prefrontal" — an earpad electrode is physically around-ear. `OVERLAY_FOOTER` is asserted
  against those words by a test.
- **Focus needs ≥ 175 SPS.** Below that, β sits above the passband and 60 Hz mains *aliases into
  β* (→15 Hz at 45 SPS, →30 Hz at 90 SPS) where it cannot be notched — mains hum then reads as
  concentration. The mains notch **defaults to 60 Hz**; do not "correct" it to 50 for North
  America.
- **Jaw clenching raises "focus" exactly like concentrating does.** β overlaps temporalis and neck
  EMG and one channel cannot separate them. The link page says so, permanently. Leave it there.

## Security invariants

The relay carries a live biometric readout **and** can put numbers on a live broadcast. Localhost
is not a boundary: every tab the streamer has open can reach `127.0.0.1`, and **WebSockets get no
CORS preflight**.

- **Never add `access-control-allow-origin: *`.** It would hand a continuous biometric feed to
  every site the streamer has open. A test asserts its absence.
- Three checks, all in `src/lib/security.ts`, and all three are needed: **loopback bind**,
  **Origin + Host pinning** (Host pinning is what stops DNS rebinding, which walks straight
  through an Origin check), and a **generated bearer token** (which is what stops a local
  non-browser process that sends no Origin).
- The token is generated into `state/` (gitignored, `0600`) — **never hardcoded, never
  committed**. `state/` must stay in `.gitignore`.
- Refusals are opaque: one 403, never "which check failed".

## Things that will bite you

- **`import.meta.url` is not a real path inside a compiled binary.** `bun build --compile` puts
  modules in a virtual filesystem (`/$bunfs/root`, or `B:\~BUN\root` on Windows), so walking `..`
  from it resolves to a filesystem root — and the server died on boot with `EROFS: mkdir '/state'`
  on unix, `EPERM: mkdir '\'` on Windows. A streamer double-clicking the binary saw it crash
  instantly, while `bun start` from source worked perfectly. `config.ts` detects this
  (`isCompiledModule`) and uses the OS user-data directory. **Always test the binary, not just
  `bun start`** — they resolve paths differently.
    - **The Windows tilde is percent-encoded.** `import.meta.url` is a *URL*, so Bun hands the
      Windows root back as `B:/%7EBUN/root`, not `~BUN` — a literal `~BUN` match misses it, the
      binary is taken for a source checkout, and it crashes. The check `decodeURIComponent`s first.
      `config.test.ts` pins the `%7E` form; and `stateDir` refuses to `mkdir` a filesystem root even
      if detection ever misses a new spelling.

- **`src/lib/{ble,dsp,focus,adc}.ts` are VENDORED** from `web-ble-monitor`, byte-identical, with a
  banner saying so. Edit them upstream and re-run `bun run sync:lib`. `bun run check:lib` fails
  the build on drift — that is the point, and it is why the copies must stay byte-identical.
  Their vitest suites are vendored too.
- **The board is the authority on its own sample rate.** Read `sps` from the firmware's `INFO`
  line; never hard-code `fs`. A wrong `fs` slides every frequency by the same ratio — real 10 Hz
  alpha rendered at ~34 Hz.
- **OBS's browser source has no Web Bluetooth.** That is *why* the relay exists. Don't try to move
  the BLE link into the overlay; it cannot work, and the device chooser needs a user gesture a
  background source can never produce. This is not a guess — OBS's CEF launches its helpers with
  `--disable-features=…,WebBluetooth`, visible in the GPU helper's command line.
- **A stale CEF lock makes every OBS browser source render blank**, including a plain `data:` URL,
  with *nothing* in any log — no crash report, an empty `~/Library/Logs/OBS_debug.log`, and OBS
  cheerfully reporting the source as active and showing. The tell is that no
  `OBS Helper (Renderer)` process exists. It happens after a quick quit→relaunch. Fix:
  `pkill -f "OBS Helper"`, then relaunch. Cost me an hour; do not re-debug the overlay for this.
- **Diagnose OBS rendering with a colour source, not a browser source.** `color_source_v3` needs no
  CEF, so if it screenshots opaque while the browser source screenshots transparent, the fault is
  obs-browser and not your page. And do not judge a PNG by its byte count: a 460×210 image of a
  *solid* colour compresses to about the same size as a fully transparent one (~475 B). Decode the
  alpha channel and look.
- **The ESP32 accepts one BLE central**, so the relay accepts one `source` socket. A second link
  page supersedes the first rather than fighting over the radio.
- **Vitest and Playwright both claim `*.spec.ts`.** `vitest.config.ts` scopes vitest to
  `src/**/*.test.ts`; browser specs live in `tests/`.
- **README images are synthetic** — real overlay, real relay, real gate, generated telemetry. The
  "Status" section says so in those words. If you regenerate them with `bun run shoot` against a
  real headset, delete that section. Until then, do not remove it.
