import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedGitProject {
	checkoutRoot: string;
	repositoryKey: string;
	repositoryLabel: string;
	name: string;
	remoteUrl: string;
}

export class GitProjectResolver {
	async resolve(cwd: string): Promise<ResolvedGitProject> {
		const rootOutput = await runGit(cwd, ["rev-parse", "--show-toplevel"], "The current directory is not inside a Git repository");
		const checkoutRoot = await realpath(rootOutput);
		const remoteUrl = await runGit(
			checkoutRoot,
			["config", "--get", "remote.origin.url"],
			"The current Git repository requires an origin remote for Pi Toolbox",
		);
		const remote = canonicalizeRemote(remoteUrl);

		return {
			checkoutRoot,
			repositoryKey: `${remote.host}/${remote.path}`,
			repositoryLabel: remote.path,
			name: remote.path.split("/").at(-1) ?? remote.path,
			remoteUrl,
		};
	}
}

export function canonicalizeRemote(remoteUrl: string): { host: string; path: string } {
	const value = remoteUrl.trim();
	if (value.length === 0) {
		throw new Error("The Git origin remote is empty");
	}

	const scpRemote = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
	if (scpRemote?.[1] && scpRemote[2] && !value.includes("://")) {
		return normalizeRemoteParts(scpRemote[1], scpRemote[2]);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error(`Unsupported Git origin remote: ${value}`, { cause: error });
	}
	if (!url.hostname) {
		throw new Error("The Git origin remote requires a host");
	}

	const port = normalizePort(url.protocol, url.port);
	const host = port ? `${url.hostname}:${port}` : url.hostname;
	return normalizeRemoteParts(host, decodeURIComponent(url.pathname));
}

function normalizeRemoteParts(host: string, repositoryPath: string): { host: string; path: string } {
	const normalizedHost = host.trim().toLowerCase();
	const path = repositoryPath
		.trim()
		.replace(/^\/+/, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	if (normalizedHost.length === 0 || path.length === 0) {
		throw new Error("The Git origin remote requires a host and repository path");
	}
	return { host: normalizedHost, path };
}

function normalizePort(protocol: string, port: string): string {
	if ((protocol === "https:" && port === "443") || (protocol === "ssh:" && port === "22")) {
		return "";
	}
	return port;
}

async function runGit(cwd: string, args: string[], errorMessage: string): Promise<string> {
	try {
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		const output = result.stdout.trim();
		if (output.length === 0) {
			throw new Error(errorMessage);
		}
		return output;
	} catch (error) {
		if (error instanceof Error && error.message === errorMessage) {
			throw error;
		}
		throw new Error(errorMessage, { cause: error });
	}
}
