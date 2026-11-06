import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_AGENT_STATE_DIR, agentStateDir, ordersJournalPath, recordsJournalPath } from '../src/setup.js';

describe('agent state folder', () => {
  test('AGENT_STATE_DIR names it; unset or empty keeps the folder in the checkout', () => {
    expect(agentStateDir({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe('/var/tmp/agent-state');
    expect(ordersJournalPath({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe(join('/var/tmp/agent-state', 'orders.jsonl'));
    expect(recordsJournalPath({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe(join('/var/tmp/agent-state', 'records.jsonl'));
    expect(agentStateDir({ AGENT_STATE_DIR: '' })).toBe(DEFAULT_AGENT_STATE_DIR);
    expect(ordersJournalPath({})).toBe(join(DEFAULT_AGENT_STATE_DIR, 'orders.jsonl'));
    expect(DEFAULT_AGENT_STATE_DIR).toMatch(/services\/agent\/state\/?$/);
  });
});
