import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tags = process.argv
  .slice(2)
  .flatMap(argument => argument.trim().split(/\s+/))
  .filter(Boolean);

if (tags.length === 0) {
  console.error('Usage: npm run test:debug -- @tag [@anotherTag]');
  process.exit(1);
}

const escapedTags = tags.map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// Tags are appended to the test title, so match them as standalone tokens.
const grep = `(?<!\\S)(?:${escapedTags.join('|')})(?!\\S)`;

const result = spawnSync(
  process.execPath,
  [resolve('node_modules/playwright/cli.js'), 'test', '--debug', '--grep', grep],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(`Unable to start Playwright: ${result.error.message}`);
}

process.exit(result.status ?? 1);
