import { MemorySettingsStore } from "../settings.ts";
import type { MemoryStatus } from "../settings-protocol.ts";
import type { MemoryConsumerSupervisor } from "./supervisor.ts";

export class MemoryServerSettings {
	constructor(
		private readonly store: MemorySettingsStore,
		private readonly consumers: MemoryConsumerSupervisor,
	) {}

	getStatus(): MemoryStatus {
		return this.store.getStatus();
	}

	async change(action: "on" | "off" | "toggle"): Promise<MemoryStatus> {
		const enabled = action === "toggle"
			? this.store.toggleEnabled()
			: this.store.setEnabled(action === "on");
		await this.consumers.setEnabled(enabled);
		return this.store.getStatus();
	}
}
