import { getAgentDir, type AgentEndEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemorySessionClient } from "./client/capture.ts";
import { MemoryServerConnection } from "./client/connection.ts";
import { createMemoryConfig, MEMORY_CLIENT_VERSION } from "./config.ts";
import type { MemoryStatus } from "./settings-protocol.ts";

export interface MemorySessionIdentity {
	sessionId: string;
	cwd: string;
}

interface MemoryClient {
	captureUser(content: string, createdAt: string): Promise<void>;
	captureAgent(content: string, createdAt: string): Promise<void>;
	settleExchange(settledAt: string): Promise<boolean>;
	getStatus(): Promise<MemoryStatus>;
	changeEnabled(action: "on" | "off" | "toggle"): Promise<MemoryStatus>;
	close(settledAt: string): Promise<void>;
	disconnect(): void;
}

type MemoryClientConnector = (identity: MemorySessionIdentity) => Promise<MemoryClient>;

export class MemoryClientRuntime {
	private identity: MemorySessionIdentity | null = null;
	private client: MemoryClient | null = null;
	private connectionFlight: Promise<MemoryClient> | null = null;

	constructor(private readonly connect: MemoryClientConnector) {}

	async start(identity: MemorySessionIdentity): Promise<void> {
		if (this.identity) {
			if (this.identity.sessionId === identity.sessionId && this.identity.cwd === identity.cwd) {
				await this.requireClient();
				return;
			}
			await this.close();
		}
		this.identity = identity;
		await this.requireClient();
	}

	async captureUser(content: string, createdAt: string): Promise<void> {
		await this.capture((client) => client.captureUser(content, createdAt));
	}

	async captureAgent(content: string, createdAt: string): Promise<void> {
		await this.capture((client) => client.captureAgent(content, createdAt));
	}

	async settleExchange(settledAt: string): Promise<void> {
		await this.capture((client) => client.settleExchange(settledAt));
	}

	async getStatus(): Promise<MemoryStatus> {
		return this.control((client) => client.getStatus());
	}

	async changeEnabled(action: "on" | "off" | "toggle"): Promise<MemoryStatus> {
		return this.control((client) => client.changeEnabled(action));
	}

	async close(): Promise<void> {
		this.identity = null;
		const connectionFlight = this.connectionFlight;
		this.connectionFlight = null;
		if (connectionFlight) {
			try {
				(await connectionFlight).disconnect();
			} catch {
				// A failed connection has no resource to close.
			}
		}
		const client = this.client;
		this.client = null;
		if (!client) return;
		try {
			await client.close(new Date().toISOString());
		} catch {
			client.disconnect();
		}
	}

	private async capture(operation: (client: MemoryClient) => Promise<unknown>): Promise<void> {
		try {
			await operation(await this.requireClient());
		} catch {
			this.disconnect();
		}
	}

	private async control<T>(operation: (client: MemoryClient) => Promise<T>): Promise<T> {
		try {
			return await operation(await this.requireClient());
		} catch (error) {
			this.disconnect();
			throw error;
		}
	}

	private async requireClient(): Promise<MemoryClient> {
		if (this.client) return this.client;
		const identity = this.identity;
		if (!identity) throw new Error("Memory session is not started");
		const connectionFlight = this.connectionFlight ?? this.connect(identity);
		this.connectionFlight = connectionFlight;
		try {
			const client = await connectionFlight;
			if (this.identity !== identity) {
				client.disconnect();
				throw new Error("Memory session changed while connecting");
			}
			this.client = client;
			return client;
		} finally {
			if (this.connectionFlight === connectionFlight) this.connectionFlight = null;
		}
	}

	private disconnect(): void {
		this.client?.disconnect();
		this.client = null;
	}
}

export interface MemoryControl {
	getStatus(): Promise<MemoryStatus>;
}

export function registerMemory(pi: ExtensionAPI): MemoryControl {
	const config = createMemoryConfig(getAgentDir());
	const runtime = new MemoryClientRuntime(async (identity) => {
		const connection = await MemoryServerConnection.connect(config, {
			clientVersion: MEMORY_CLIENT_VERSION,
			sessionId: identity.sessionId,
			cwd: identity.cwd,
		});
		try {
			await connection.request("connectSession", {});
			return new MemorySessionClient(connection);
		} catch (error) {
			connection.close();
			throw error;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		// Not awaited: Pi waits for session_start handlers before rendering startup,
		// and a slow or failing memory server must not delay or interrupt the session.
		// Later captures join the same in-flight connection.
		runtime.start({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }).catch(() => undefined);
	});

	pi.on("message_end", async (event) => {
		const content = getConversationMessageText(event.message);
		if (content.length === 0) return;
		const createdAt = new Date(event.message.timestamp).toISOString();
		if (event.message.role === "user") {
			await runtime.captureUser(content, createdAt);
		} else if (event.message.role === "assistant" && event.message.stopReason === "stop") {
			await runtime.captureAgent(content, createdAt);
		}
	});

	pi.on("agent_settled", async () => {
		await runtime.settleExchange(new Date().toISOString());
	});

	pi.on("session_shutdown", async () => {
		await runtime.close();
	});

	pi.registerCommand("tb-memory", {
		description: "Enable or disable Memory globally",
		handler: async (args, ctx) => {
			try {
				const action = parseMemoryCommandAction(args);
				const status = await runtime.changeEnabled(action);
				ctx.ui.notify(`Memory is ${status.enabled ? "on" : "off"}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	return { getStatus: () => runtime.getStatus() };
}

export function getConversationMessageText(message: AgentEndEvent["messages"][number]): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((part) => part.type === "text" && part.text.trim().length > 0)
		.map((part) => part.type === "text" ? part.text.trim() : "")
		.join("\n\n");
}

type MemoryCommandAction = "on" | "off" | "toggle";

function parseMemoryCommandAction(args: string): MemoryCommandAction {
	const action = args.trim().toLowerCase() || "toggle";
	if (action === "on" || action === "off" || action === "toggle") return action;
	throw new Error("Usage: /tb-memory [on|off|toggle]");
}
