import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runCurationConsumer } = await jiti.import("./consumer.ts");
runCurationConsumer();
