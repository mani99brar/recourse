// recourse-agent service: the read-only approvals API on 127.0.0.1:AGENT_PORT. Orders are placed
// and approved with the `order` and `approve` commands; this service only shows what is pending.

import { createLogger, readJournal } from '@recourse/records';
import { createApprovalsApi } from './approvals-api.js';
import type { AgentRow } from './buy.js';
import { ordersJournalPath } from './setup.js';

const log = createLogger('agent');
const port = Number(process.env.AGENT_PORT ?? '8722');
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  log.error('boot_failed', { error: 'AGENT_PORT: not a port number' });
  process.exit(1);
}
const journalPath = ordersJournalPath(process.env);
const app = createApprovalsApi({ rows: () => readJournal<AgentRow>(journalPath).rows, log });
app.listen(port, '127.0.0.1', () => log.info('listening', { port, journal: journalPath }));
