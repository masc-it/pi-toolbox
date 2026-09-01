import { readFileSync, writeFileSync } from "node:fs";

const configPath = process.argv[2];
if (!configPath) throw new Error("Extractor fixture requires a config path");
const config = JSON.parse(readFileSync(configPath, "utf8"));
let attempt = 0;
try {
	attempt = Number(readFileSync(config.attemptsPath, "utf8"));
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}
attempt++;
writeFileSync(config.attemptsPath, String(attempt));
await new Promise((resolve) => setTimeout(resolve, config.delayMs));
if (attempt <= config.failAttempts) {
	process.stderr.write("planned extraction failure\n");
	process.exit(1);
}
const finalText = JSON.stringify({ facts: config.facts });
process.stdout.write(`${JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: finalText }],
	},
})}\n`);
