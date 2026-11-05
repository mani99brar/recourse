// recourse-shop service entry point.

import { startShop } from './boot.js';

startShop().catch((error: unknown) => {
  console.error(JSON.stringify({ service: 'shop', level: 'error', event: 'boot_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
