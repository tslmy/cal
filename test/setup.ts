import { rmSync } from "node:fs";

// Each test worker gets its own fresh state file, so files can't see each other's people.
const file = `node_modules/.tmp/test/evolve-${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0}.json`;
rmSync(file, { force: true });
process.env.EVOLVE_DATA = file;
