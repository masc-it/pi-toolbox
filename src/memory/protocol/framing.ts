export const MEMORY_MAX_FRAME_BYTES = 1024 * 1024;
const FRAME_HEADER_BYTES = 4;

export function encodeMemoryFrame(value: unknown): Buffer {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("Memory frame payload is not JSON serializable");
	const payload = Buffer.from(json, "utf8");
	if (payload.length === 0 || payload.length > MEMORY_MAX_FRAME_BYTES) {
		throw new Error(`Memory frame payload must be between 1 and ${MEMORY_MAX_FRAME_BYTES} bytes`);
	}
	const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
	frame.writeUInt32BE(payload.length, 0);
	payload.copy(frame, FRAME_HEADER_BYTES);
	return frame;
}

export class MemoryFrameDecoder {
	private buffered: Buffer = Buffer.alloc(0);

	constructor(private readonly receive: (value: unknown) => void) {}

	push(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
		while (this.buffered.length >= FRAME_HEADER_BYTES) {
			const payloadLength = this.buffered.readUInt32BE(0);
			if (payloadLength === 0 || payloadLength > MEMORY_MAX_FRAME_BYTES) {
				throw new Error(`Invalid Memory frame length: ${payloadLength}`);
			}
			const frameLength = FRAME_HEADER_BYTES + payloadLength;
			if (this.buffered.length < frameLength) return;
			const payload = this.buffered.subarray(FRAME_HEADER_BYTES, frameLength);
			this.buffered = this.buffered.subarray(frameLength);
			this.receive(parseJson(payload));
		}
	}

	finish(): void {
		if (this.buffered.length !== 0) throw new Error("Memory connection ended with a partial frame");
	}
}

function parseJson(payload: Buffer): unknown {
	try {
		return JSON.parse(payload.toString("utf8"));
	} catch {
		throw new Error("Memory frame contains invalid JSON");
	}
}
