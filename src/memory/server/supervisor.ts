import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	MEMORY_PROTOCOL_VERSION,
	parseMemoryConsumerMessage,
	type MemoryConsumerWake,
	type MemoryQueueName,
} from "../protocol/messages.ts";

const CONSUMER_READY_TIMEOUT_MS = 10_000;
const CONSUMER_STOP_TIMEOUT_MS = 5_000;
const CONSUMER_RESTART_DELAY_MS = 100;

interface ConsumerSlot {
	readonly queue: MemoryQueueName;
	readonly entryPath: string;
	child: ChildProcess | null;
	ready: boolean;
	wakePending: boolean;
	restartTimer: NodeJS.Timeout | null;
}

export interface MemoryConsumerEntries {
	extraction: string;
	curation: string;
}

export class MemoryConsumerSupervisor {
	private readonly slots: Record<MemoryQueueName, ConsumerSlot>;
	private running = false;

	constructor(entries: MemoryConsumerEntries = defaultConsumerEntries()) {
		this.slots = {
			extraction: createSlot("extraction", entries.extraction),
			curation: createSlot("curation", entries.curation),
		};
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await Promise.all([this.spawn(this.slots.extraction), this.spawn(this.slots.curation)]);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.running && !this.slots.extraction.child && !this.slots.curation.child) return;
		this.running = false;
		await Promise.all(Object.values(this.slots).map((slot) => this.stopSlot(slot)));
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.start();
		} else {
			await this.stop();
		}
	}

	wake(queue: MemoryQueueName): void {
		const slot = this.slots[queue];
		if (!this.running) return;
		if (!slot.child?.connected || !slot.ready) {
			slot.wakePending = true;
			return;
		}
		this.sendWake(slot);
	}

	consumerPid(queue: MemoryQueueName): number | null {
		return this.slots[queue].child?.pid ?? null;
	}

	private spawn(slot: ConsumerSlot): Promise<void> {
		if (!this.running) return Promise.resolve();
		if (slot.child) throw new Error(`Memory ${slot.queue} consumer is already running`);

		const child = fork(slot.entryPath, [], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		slot.child = child;
		slot.ready = false;

		return new Promise<void>((resolve, reject) => {
			let startupSettled = false;
			const readyTimeout = setTimeout(() => {
				finishStartup(new Error(`Memory ${slot.queue} consumer readiness timed out`));
				child.kill("SIGKILL");
			}, CONSUMER_READY_TIMEOUT_MS);

			const finishStartup = (error?: Error): void => {
				if (startupSettled) return;
				startupSettled = true;
				clearTimeout(readyTimeout);
				if (error) reject(error);
				else resolve();
			};

			child.on("message", (value: unknown) => {
				let message;
				try {
					message = parseMemoryConsumerMessage(value);
				} catch (error) {
					finishStartup(toError(error));
					child.kill("SIGKILL");
					return;
				}
				if (message.consumer !== slot.queue) {
					finishStartup(new Error(`Memory ${slot.queue} consumer reported the wrong queue`));
					child.kill("SIGKILL");
					return;
				}
				if (message.type === "ready") {
					slot.ready = true;
					finishStartup();
					if (slot.wakePending) this.sendWake(slot);
				}
			});
			child.once("error", (error) => finishStartup(error));
			child.once("exit", (code, signal) => {
				finishStartup(new Error(formatConsumerExit(slot.queue, code, signal)));
				if (slot.child !== child) return;
				slot.child = null;
				slot.ready = false;
				if (this.running) this.scheduleReplacement(slot);
			});
		});
	}

	private scheduleReplacement(slot: ConsumerSlot): void {
		if (slot.restartTimer || !this.running) return;
		slot.restartTimer = setTimeout(() => {
			slot.restartTimer = null;
			void this.spawn(slot).catch(() => this.scheduleReplacement(slot));
		}, CONSUMER_RESTART_DELAY_MS);
	}

	private sendWake(slot: ConsumerSlot): void {
		const wake: MemoryConsumerWake = {
			type: "wake",
			version: MEMORY_PROTOCOL_VERSION,
			queue: slot.queue,
		};
		slot.wakePending = false;
		try {
			slot.child?.send(wake);
		} catch {
			slot.wakePending = true;
		}
	}

	private async stopSlot(slot: ConsumerSlot): Promise<void> {
		if (slot.restartTimer) {
			clearTimeout(slot.restartTimer);
			slot.restartTimer = null;
		}
		slot.wakePending = false;
		const child = slot.child;
		if (!child) return;
		slot.child = null;
		slot.ready = false;
		child.kill("SIGTERM");
		await waitForExit(child, CONSUMER_STOP_TIMEOUT_MS);
	}
}

function createSlot(queue: MemoryQueueName, entryPath: string): ConsumerSlot {
	return { queue, entryPath, child: null, ready: false, wakePending: false, restartTimer: null };
}

function defaultConsumerEntries(): MemoryConsumerEntries {
	return {
		extraction: fileURLToPath(new URL("../extraction/entry.mjs", import.meta.url)),
		curation: fileURLToPath(new URL("../curation/entry.mjs", import.meta.url)),
	};
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function formatConsumerExit(queue: MemoryQueueName, code: number | null, signal: NodeJS.Signals | null): string {
	return signal
		? `Memory ${queue} consumer exited from ${signal}`
		: `Memory ${queue} consumer exited with code ${String(code)}`;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
