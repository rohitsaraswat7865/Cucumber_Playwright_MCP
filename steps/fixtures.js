import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from 'playwright-bdd';

// Generated and gitignored (CLAUDE.md §1); `npm run clean` empties it.
const dataRoot = fileURLToPath(new URL('../.test-data/', import.meta.url));

// Fixtures injected into step definitions by name, e.g. `async ({ page, testData }) => {}`.
// Only steps registered through `createBdd(test)` with this `test` can use them (CLAUDE.md §6).
export const test = base.extend({
  // One isolated data.json and lifecycle per Playwright worker.
  workerData: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      // workerIndex is unique within a run; a restarted worker (after a failure) gets a new one.
      const workerDir = path.join(dataRoot, `worker-${workerInfo.workerIndex}`);
      const dataFile = path.join(workerDir, 'data.json');
      const data = {};
      const save = () => writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);

      // Start this worker with a fresh data file, replacing anything an aborted run left behind.
      rmSync(workerDir, { recursive: true, force: true });
      mkdirSync(workerDir, { recursive: true });
      save();

      /** Look up a value in this worker's data by dotted path. */
      function get(dataPath) {
        const value = dataPath.split('.').reduce((node, key) => node?.[key], data);
        if (value === undefined) throw new Error(`data.json has no entry "${dataPath}"`);
        return value;
      }

      /** Store a value by dotted path and write it through to data.json. */
      function set(dataPath, value) {
        const keys = dataPath.split('.');
        const last = keys.pop();
        const node = keys.reduce((parent, key) => (parent[key] ??= {}), data);
        node[last] = value;
        save();
      }

      try {
        await use({ dataFile, get, set });
      } finally {
        // Dispose of this worker's data when the worker ends.
        rmSync(workerDir, { recursive: true, force: true });
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Fresh mutable object per scenario, shared by every step in it (the PicoContainer-style context).
  // eslint-disable-next-line no-empty-pattern
  scenarioCtx: async ({}, use) => {
    await use({});
  },

  testData: async ({ workerData }, use) => {
    await use(workerData);
  },
});
