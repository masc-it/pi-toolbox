import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runMemoryServerFromEnvironment } = await jiti.import("./runtime.ts");
await runMemoryServerFromEnvironment();
