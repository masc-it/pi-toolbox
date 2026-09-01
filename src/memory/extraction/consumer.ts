import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryConsumerWake,
	type MemoryConsumerMessage,
} from "../protocol/messages.ts";

export function runExtractionConsumer(): void {
	if (!process.send) throw new Error("Memory extraction consumer requires an IPC channel");
	process.on("message", (value: unknown) => {
		parseMemoryConsumerWake(value, "extraction");
		post({ type: "drained", version: MEMORY_PROTOCOL_VERSION, consumer: "extraction" });
	});
	post({ type: "ready", version: MEMORY_PROTOCOL_VERSION, consumer: "extraction" });
}

function post(message: MemoryConsumerMessage): void {
	process.send?.(message);
}
