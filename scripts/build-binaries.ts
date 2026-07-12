// Build standalone, single-file executables — no Bun, no Node, no git, no terminal literacy.
//
//   bun run build          → dist/neurohud-<platform>[.exe]
//
// This is the difference between "developers can use this" and "streamers can use this". A
// streamer downloads one file, runs it, and their browser opens on the setup page. Everything
// else — the headset, the OBS URL — happens there.

import { $ } from 'bun';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

/** Bun's cross-compilation targets. macOS arm64 is the dev box; the rest are cross-built. */
const TARGETS = [
	{ target: 'bun-darwin-arm64', out: 'neurohud-macos-arm64', label: 'macOS (Apple Silicon)' },
	{ target: 'bun-darwin-x64', out: 'neurohud-macos-x64', label: 'macOS (Intel)' },
	{ target: 'bun-windows-x64', out: 'neurohud-windows-x64.exe', label: 'Windows' },
	{ target: 'bun-linux-x64', out: 'neurohud-linux-x64', label: 'Linux' }
] as const;

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const { target, out, label } of TARGETS) {
	process.stdout.write(`  ${label.padEnd(24)} `);
	try {
		await $`bun build --compile --minify --target=${target} ${join(ROOT, 'server.ts')} --outfile ${join(DIST, out)}`.quiet();
		const size = Bun.file(join(DIST, out)).size;
		console.log(`✓ dist/${out}  (${(size / 1e6).toFixed(0)} MB)`);
	} catch (e) {
		console.log(`✗ ${e instanceof Error ? e.message.split('\n')[0] : e}`);
	}
}

console.log(`
  Each binary embeds the Bun runtime, both pages, and the DSP. Nothing else to install.

  On first run it generates its access token into the OS user-data directory
  (~/Library/Application Support/NeuroHUD, %APPDATA%\\NeuroHUD, ~/.local/share/neurohud)
  — NOT next to the executable, which may sit in Downloads or on a read-only volume.
`);
