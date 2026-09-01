import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryConsumerWake,
	type MemoryConsumerMessage,
} from "../protocol/messages.ts";

export function runCurationConsumer(): void {
	if (!process.send) throw new Error("Memory curation consumer requires an IPC channel");
	process.on("message", (value: unknown) => {
		parseMemoryConsumerWake(value, "curation");
		post({ type: "drained", version: MEMORY_PROTOCOL_VERSION, consumer: "curation" });
	});
	post({ type: "ready", version: MEMORY_PROTOCOL_VERSION, consumer: "curation" });
}

function post(message: MemoryConsumerMessage): void {
	process.send?.(message);
}
