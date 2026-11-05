// recourse-docket service entry point.

import { LockHeldError } from './lock.js';
import { startDocket } from './boot.js';

startDocket().catch((error: unknown) => {
  console.error(JSON.stringify({ service: 'docket', level: 'error', event: 'boot_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(error instanceof LockHeldError ? 3 : 1);
});
