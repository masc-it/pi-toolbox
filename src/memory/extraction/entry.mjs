import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runExtractionConsumer } = await jiti.import("./consumer.ts");
runExtractionConsumer();
