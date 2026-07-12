// `gifenc` ships no types. Only the three entry points scripts/shoot.ts uses are declared.
declare module 'gifenc' {
	export interface WriteFrameOptions {
		palette?: number[][];
		/** Centiseconds… no: milliseconds. gifenc rounds to the GIF's 10 ms tick internally. */
		delay?: number;
		transparent?: boolean;
		repeat?: number;
	}

	export interface Encoder {
		writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
		finish(): void;
		bytes(): Uint8Array;
	}

	export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;

	export function quantize(
		rgba: Uint8Array | Uint8ClampedArray,
		maxColors: number,
		opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean }
	): number[][];

	export function applyPalette(
		rgba: Uint8Array | Uint8ClampedArray,
		palette: number[][],
		format?: 'rgb565' | 'rgb444' | 'rgba4444'
	): Uint8Array;
}
