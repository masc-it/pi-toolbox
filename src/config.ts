import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PROMPT_POLISH_PROFILE,
	THINKING_LEVELS,
	type ToolboxConfig,
	type WorkflowId,
	type WorkflowModelProfile,
} from "./domain.ts";

const CONFIG_DIRECTORY = "pi-toolbox";
const CONFIG_FILENAME = "config.json";

export class ToolboxConfigStore {
	readonly path: string;

	constructor(agentDirectory = getAgentDir()) {
		this.path = join(agentDirectory, CONFIG_DIRECTORY, CONFIG_FILENAME);
	}

	async load(): Promise<ToolboxConfig> {
		try {
			const content = await readFile(this.path, "utf8");
			return parseConfig(JSON.parse(content) as unknown);
		} catch (error) {
			if (isMissingFile(error)) {
				return createDefaultConfig();
			}
			throw new Error(`Unable to read Pi Toolbox config at ${this.path}`, { cause: error });
		}
	}

	async saveModelProfile(workflow: WorkflowId, profile: WorkflowModelProfile): Promise<ToolboxConfig> {
		const config = await this.load();
		const updated: ToolboxConfig = {
			models: {
				...config.models,
				[workflow]: profile,
			},
		};

		await writeJsonAtomically(this.path, updated);
		return updated;
	}
}

export function createDefaultConfig(): ToolboxConfig {
	return {
		models: {
			prompt_polish: { ...DEFAULT_PROMPT_POLISH_PROFILE },
		},
	};
}

function parseConfig(value: unknown): ToolboxConfig {
	if (!isRecord(value) || !isRecord(value.models)) {
		throw new Error("Configuration must contain a models object");
	}

	return {
		models: {
			prompt_polish: parseOptionalProfile(value.models.prompt_polish) ?? { ...DEFAULT_PROMPT_POLISH_PROFILE },
		},
	};
}

function parseOptionalProfile(value: unknown): WorkflowModelProfile | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (!isRecord(value)) {
		throw new Error("A workflow model profile must be an object or null");
	}
	if (typeof value.provider !== "string" || value.provider.length === 0) {
		throw new Error("A workflow model profile requires a provider");
	}
	if (typeof value.model !== "string" || value.model.length === 0) {
		throw new Error("A workflow model profile requires a model");
	}
	if (!isThinkingLevel(value.thinkingLevel)) {
		throw new Error("A workflow model profile contains an invalid thinking level");
	}

	return {
		provider: value.provider,
		model: value.model,
		thinkingLevel: value.thinkingLevel,
	};
}

async function writeJsonAtomically(path: string, value: ToolboxConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw new Error(`Unable to save Pi Toolbox config at ${path}`, { cause: error });
	}
}

function isThinkingLevel(value: unknown): value is WorkflowModelProfile["thinkingLevel"] {
	return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
