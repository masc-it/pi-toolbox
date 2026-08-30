import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
await jiti.import("./settings-worker-runtime.ts");
