import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = process.argv[2];
if (!configPath) throw new Error("Curator fixture requires a config path");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const isCuration = process.argv.includes("--tools");

if (isCuration) {
	const input = JSON.parse(process.argv.at(-1));
	appendFileSync(config.attemptsPath, `${input.projectWorkingDirectory}\n`);
	if (config.activePath) writeFileSync(config.activePath, "active");
	if (config.releasePath) {
		while (!existsSync(config.releasePath)) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
	if (config.commit) {
		writeFileSync(
			join(process.cwd(), "coding", "fixture-memory.md"),
			"---\ntype: fact\ntitle: Fixture memory\n---\n\n# Fixture memory\n\nThe queued fact was committed.\n",
		);
	}
}

const finalText = JSON.stringify(
	isCuration
		? { commitMessage: config.commit ? "memory(global): record fixture memory" : null }
		: { facts: config.extractionFacts ?? [] },
);
process.stdout.write(`${JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: finalText }],
	},
})}\n`);
