// Runtime configuration. Nothing here is hardcoded and nothing here is committed — the token is
// generated on first run and lives in `state/`, which is gitignored.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateToken } from './security';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Generated secrets, the OBS text-source mirror. Gitignored — never commit this directory. */
export const STATE_DIR = join(ROOT, 'state');
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
