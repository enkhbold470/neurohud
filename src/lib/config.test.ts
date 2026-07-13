import { describe, expect, it } from 'vitest';

import { isCompiledModule } from './config';

// The compiled-binary detection is what decides whether the token and text mirror land in the
// repo's `state/` (dev) or the OS user-data dir (a shipped binary). Get it wrong for a binary and
// the server walks `..` off Bun's virtual filesystem onto a filesystem root and dies on boot
// trying to `mkdir` it — `EROFS: mkdir '/state'` on unix, `EPERM: mkdir '\'` on Windows.
describe('isCompiledModule', () => {
	it('detects the unix virtual-FS root', () => {
		expect(isCompiledModule('file:///$bunfs/root/neurohud-linux-x64')).toBe(true);
	});

	it('detects the Windows virtual-FS root when the tilde is raw', () => {
		expect(isCompiledModule('file:///B:/~BUN/root/neurohud-windows-x64.exe')).toBe(true);
	});

	// The bug that shipped and crashed the Windows binary: `import.meta.url` is a URL, so Bun hands
	// the root back with the tilde percent-encoded. A literal `~BUN` match missed it, the binary
	// was taken for a source checkout, and it died on boot with `EPERM: mkdir '\'`.
	it('detects the Windows virtual-FS root when the tilde is percent-encoded', () => {
		expect(isCompiledModule('file:///B:/%7EBUN/root/neurohud-windows-x64.exe')).toBe(true);
		expect(isCompiledModule('file:///B:/%7eBUN/root/x.exe')).toBe(true); // lowercase %7e decodes too
	});

	it('treats a real source checkout as NOT compiled', () => {
		expect(isCompiledModule('file:///home/user/neurohud/src/lib/config.ts')).toBe(false);
		expect(isCompiledModule('file:///C:/Users/dev/neurohud/src/lib/config.ts')).toBe(false);
	});

	it('does not false-positive on a real path that merely contains the substring', () => {
		expect(isCompiledModule('file:///Users/me/~BUNny/app/config.ts')).toBe(false);
	});

	it('tolerates malformed percent-escapes instead of throwing on boot', () => {
		expect(() => isCompiledModule('file:///C:/weird%ZZ/config.ts')).not.toThrow();
		expect(isCompiledModule('file:///C:/weird%ZZ/config.ts')).toBe(false);
	});
});
