// Runtime configuration. Nothing here is hardcoded and nothing here is committed — the token is
// generated on first run and lives in the state directory, which is gitignored.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateToken } from './security';

/**
 * True when `moduleUrl` names a module inside a `bun build --compile` standalone binary rather
 * than a real file on disk.
 *
 * A compiled binary runs its modules from Bun's virtual filesystem — `/$bunfs/root` on unix,
 * `B:\~BUN\root` on Windows — so `import.meta.url` points at nowhere real. Walking `..` from there
 * lands on a filesystem root, and the server dies on boot trying to `mkdir` it: `EROFS: mkdir
 * '/state'` on unix, `EPERM: mkdir '\'` on Windows. A streamer double-clicking the binary sees it
 * crash instantly, while `bun start` from source works perfectly.
 *
 * The tilde is the trap that shipped. Bun spells the Windows root `~BUN`, but `import.meta.url` is
 * a URL and hands the tilde back percent-encoded — `%7EBUN` — so a literal `~BUN` match misses it,
 * the binary is taken for a source checkout, and it crashes. Decode first, then match. Exported so
 * a test can pin exactly the forms Bun emits.
 */
export function isCompiledModule(moduleUrl: string): boolean {
	let path = moduleUrl;
	try {
		path = decodeURIComponent(moduleUrl);
	} catch {
		/* malformed %-escapes — fall back to the raw URL, which still catches the un-encoded roots */
	}
	return /[\\/]\$bunfs[\\/]|[\\/]~BUN[\\/]/.test(path);
}

const COMPILED = isCompiledModule(import.meta.url);

/** A filesystem root (`/`, `C:\`, `B:\`) is its own parent. Never `mkdir` one. */
function isFilesystemRoot(p: string): boolean {
	return resolve(p) === resolve(p, '..');
}

/**
 * Where the generated token and the OBS text mirror live.
 *
 * From source: `state/` in the repo, which is gitignored and easy to find.
 * From a binary: the OS's per-user data directory, because the binary may sit anywhere — in
 * Downloads, on a read-only volume, or in a directory the user cannot write to.
 */
function stateDir(): string {
	const override = process.env.NEUROHUD_STATE_DIR;
	if (override) return override;

	if (!COMPILED) {
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
		// Belt and suspenders for the boot crash above: if `COMPILED` ever misses a new virtual-FS
		// spelling, `repoRoot` is a filesystem root, not a checkout. Fall through to the OS data
		// dir rather than `mkdir` the root.
		if (!isFilesystemRoot(repoRoot)) return join(repoRoot, 'state');
	}

	const home = homedir();
	switch (platform()) {
		case 'darwin':
			return join(home, 'Library', 'Application Support', 'NeuroHUD');
		case 'win32':
			// `env()` (not `??`) so an empty `APPDATA` falls back too — otherwise the state dir is
			// relative, and a double-clicked binary's cwd is anyone's guess.
			return join(env('APPDATA') ?? join(home, 'AppData', 'Roaming'), 'NeuroHUD');
		default:
			return join(env('XDG_DATA_HOME') ?? join(home, '.local', 'share'), 'neurohud');
	}
}

/** Generated secrets, and the OBS text-source mirror. Never commit this directory. */
export const STATE_DIR = stateDir();
export const TOKEN_FILE = join(STATE_DIR, 'token');
export const TEXT_FILE = join(STATE_DIR, 'focus.txt');

export interface Config {
	port: number;
	host: string;
	token: string;
	/** True when the relay is bound off-loopback — the one configuration that needs a warning. */
	exposed: boolean;
	origin: string;
}

function env(...names: string[]): string | undefined {
	for (const n of names) {
		const v = process.env[n];
		if (v !== undefined && v !== '') return v;
	}
	return undefined;
}

/**
 * The token authorises every socket and every read of `/state.json`.
 *
 * Precedence: `$NEUROHUD_TOKEN` (for anyone scripting this) beats the generated file. If neither
 * exists we mint one and persist it, so the OBS browser-source URL a streamer pastes in once
 * keeps working across restarts — a token that rotated on every boot would mean re-pasting the
 * URL before every stream, and a tool that is annoying to use securely gets used insecurely.
 */
export function loadToken(): string {
	const fromEnv = env('NEUROHUD_TOKEN');
	if (fromEnv) return fromEnv;

	mkdirSync(STATE_DIR, { recursive: true });
	if (existsSync(TOKEN_FILE)) {
		const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
		if (saved) return saved;
	}

	const token = generateToken();
	writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
	try {
		chmodSync(TOKEN_FILE, 0o600); // owner-only, even if the file already existed
	} catch {
		/* best effort — Windows has no POSIX mode bits */
	}
	return token;
}

export function loadConfig(): Config {
	const port = Number(env('NEUROHUD_PORT', 'PORT') ?? 8787);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${env('NEUROHUD_PORT', 'PORT')}`);
	}

	// Loopback by default. Binding to 0.0.0.0 would put a live biometric feed on the local
	// network — opt in explicitly, and get told about it.
	const host = env('NEUROHUD_HOST', 'HOST') ?? '127.0.0.1';
	const exposed = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';

	const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

	return {
		port,
		host,
		token: loadToken(),
		exposed,
		origin: `http://${displayHost}:${port}`
	};
}
