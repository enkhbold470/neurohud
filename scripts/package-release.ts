// Package the binaries so a human can actually launch them.
//
//   bun run package     → dist/release/*.zip  |  *.tar.gz
//
// ## Why archives, and not the bare binary
//
// GitHub serves release assets as plain octet-streams, so **the executable bit does not survive
// the download**. A downloaded `neurohud-macos-arm64` arrives `-rw-r--r--`, and Finder — seeing a
// file with no extension that it is not allowed to run — hands it to **TextEdit**, which
// cheerfully renders the Mach-O header as mojibake. The user's first experience of the product is
// a screen full of `__PAGEZERO __TEXT /usr/lib/dyld`.
//
// Zip and tar both store the permission bits, so unpacking restores `+x`. That is the entire fix.
//
// On macOS we also ship a `.command` launcher: double-clicking one opens Terminal and runs it,
// which is the closest an unsigned tool gets to "double-click and go". It strips the quarantine
// flag off the binary itself, so Gatekeeper only has to be satisfied once, for the script.

import { $ } from 'bun';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'release');

interface Build {
	bin: string;
	dir: string;
	archive: string;
	kind: 'mac' | 'win' | 'linux';
}

const BUILDS: Build[] = [
	{ bin: 'neurohud-macos-arm64', dir: 'NeuroHUD-macOS-AppleSilicon', archive: 'NeuroHUD-macOS-AppleSilicon.zip', kind: 'mac' },
	{ bin: 'neurohud-macos-x64', dir: 'NeuroHUD-macOS-Intel', archive: 'NeuroHUD-macOS-Intel.zip', kind: 'mac' },
	{ bin: 'neurohud-windows-x64.exe', dir: 'NeuroHUD-Windows', archive: 'NeuroHUD-Windows.zip', kind: 'win' },
	{ bin: 'neurohud-linux-x64', dir: 'NeuroHUD-Linux', archive: 'NeuroHUD-Linux.tar.gz', kind: 'linux' }
];

/**
 * The macOS launcher. Double-clicking a `.command` opens Terminal and executes it.
 *
 * It clears the quarantine flag from the *binary* before running it — otherwise Gatekeeper
 * blocks the unsigned executable a second time, from inside Terminal, where the user has no
 * right-click → Open escape hatch and just sees "killed: 9".
 */
const MAC_LAUNCHER = `#!/bin/bash
# NeuroHUD — double-click me.
cd "$(dirname "$0")" || exit 1

# Strip the quarantine flag macOS puts on anything downloaded. Without this the unsigned
# binary is killed on sight, from inside Terminal, with no way for the user to approve it.
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x ./neurohud 2>/dev/null

echo ""
echo "  Starting NeuroHUD… your browser will open on the setup page."
echo "  Keep this window open while you stream. Press Ctrl-C to stop."
echo ""
exec ./neurohud
`;

const WIN_LAUNCHER = `@echo off
title NeuroHUD
echo.
echo   Starting NeuroHUD... your browser will open on the setup page.
echo   Keep this window open while you stream. Press Ctrl-C to stop.
echo.
"%~dp0neurohud.exe"
pause
`;

const LINUX_LAUNCHER = `#!/bin/bash
cd "$(dirname "$0")" || exit 1
chmod +x ./neurohud 2>/dev/null
exec ./neurohud
`;

const READ_ME = (kind: Build['kind']): string => {
	const open =
		kind === 'mac'
			? `1. RIGHT-CLICK "NeuroHUD.command"  ->  Open  ->  Open.

   (Right-click, not double-click, the FIRST time only. NeuroHUD is not signed
   by Apple — signing costs $99/yr — so Gatekeeper wants you to confirm once.
   After that, a normal double-click works.)`
			: kind === 'win'
				? `1. Double-click "NeuroHUD.bat".

   (Windows SmartScreen will warn you: NeuroHUD is not code-signed.
   Click "More info" -> "Run anyway".)`
				: `1. Run ./NeuroHUD.sh  (or ./neurohud directly).`;

	return `NeuroHUD — your focus, live on stream.
===========================================

${open}

2. Your browser opens on the setup page. Connect your headset there and
   wait out the 20-second calibration.

3. Hit "Copy" to copy the overlay URL.

4. In OBS:  Sources -> + -> Browser -> paste the URL
            Width 420, Height 200
            Untick "Shutdown source when not visible"

That's it. Leave the NeuroHUD window running while you stream.


THE OVERLAY URL CONTAINS YOUR ACCESS TOKEN.
Treat it like a password. Don't show it on stream, and don't screenshot the
OBS browser-source properties dialog.


WHAT THE NUMBER IS
------------------
50 means YOUR OWN baseline, frozen after the first 20 seconds. It is not
comparable to anyone else's, and only meaningful within one session.

Clenching your jaw raises "focus" exactly like concentrating does — beta
overlaps jaw and neck muscle activity, and one channel cannot separate them.

There is no stress reading. A single around-ear channel cannot support one.

NeuroHUD refuses to show a number it cannot defend: a detached electrode, a
sample rate below 175 SPS, or an unfrozen baseline each show a dash, never a
zero. If the link dies mid-stream, the overlay disappears rather than freeze
a stale number on your broadcast.

Not a medical device.

https://github.com/enkhbold470/neurohud
`;
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const b of BUILDS) {
	const staging = join(OUT, b.dir);
	await mkdir(staging, { recursive: true });

	const binName = b.kind === 'win' ? 'neurohud.exe' : 'neurohud';
	await $`cp ${join(DIST, b.bin)} ${join(staging, binName)}`.quiet();
	await chmod(join(staging, binName), 0o755);

	if (b.kind === 'mac') {
		await writeFile(join(staging, 'NeuroHUD.command'), MAC_LAUNCHER);
		await chmod(join(staging, 'NeuroHUD.command'), 0o755);
	} else if (b.kind === 'win') {
		await writeFile(join(staging, 'NeuroHUD.bat'), WIN_LAUNCHER);
	} else {
		await writeFile(join(staging, 'NeuroHUD.sh'), LINUX_LAUNCHER);
		await chmod(join(staging, 'NeuroHUD.sh'), 0o755);
	}

	await writeFile(join(staging, 'READ ME FIRST.txt'), READ_ME(b.kind));

	// `zip -y` would store symlinks; there are none. Permissions ARE stored, which is the point.
	if (b.archive.endsWith('.zip')) {
		await $`cd ${OUT} && zip -qr ${b.archive} ${b.dir}`.quiet();
	} else {
		await $`cd ${OUT} && tar czf ${b.archive} ${b.dir}`.quiet();
	}
	await rm(staging, { recursive: true, force: true });

	const size = Bun.file(join(OUT, b.archive)).size;
	console.log(`  ✓ ${b.archive.padEnd(34)} ${(size / 1e6).toFixed(0)} MB`);
}

console.log(`
  These archives preserve the executable bit. A bare binary downloaded from a
  GitHub release does NOT — it arrives rw-r--r--, and Finder opens it in TextEdit.
`);
