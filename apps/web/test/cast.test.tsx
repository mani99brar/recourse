import { readFileSync } from 'node:fs';
import type { VaultToken } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell, route } from '../src/App.js';
import { fromV1 } from '../src/lib/api.js';
import { CAST_READ, CastView, type CastBody, type CastMember } from '../src/pages/Cast.js';

const REGISTRY = '0x' + '80'.repeat(20);
const registry = { chainId: 296, address: REGISTRY, accountId: '0.0.7000', explorer: `https://hashscan.io/testnet/contract/${REGISTRY}` };
const mock: VaultToken = { mode: 'mock', address: `0x${'6d'.repeat(20)}`, decimals: 6, symbol: 'mUSDC', label: 'mUSDC (testnet mock)', tokenId: null };

let n = 0;
function member(role: 'shop' | 'platform', name: string, type: [string, string, string] | null, over: Partial<CastMember> = {}): CastMember {
  n++;
  const address = '0x' + n.toString(16).padStart(2, '0').repeat(20);
  return {
    agentId: String(148 + n),
    role,
    displayName: name,
    address,
    owner: address,
    ownerIsParty: true,
    agentURI: 'data:application/json;base64,e30=',
    registration: { name, description: `${name} in the demo.`, recourse: type ? { role, kind: type[0], label: type[1], summary: type[2] } : null },
    readAt: 1_793_990_000,
    current: true,
    explorer: registry.explorer,
    ownerExplorer: `https://hashscan.io/testnet/account/${address}`,
    orders: 0,
    claims: [],
    ...over,
  };
}

const claim = (statusKey: CastMember['claims'][number]['statusKey'], findingSide: string | null, paid: string | null, i: number) => ({
  claimId: '0x' + i.toString(16).padStart(2, '0').repeat(32),
  statusKey,
  answer: findingSide === 'platform' ? 1 : findingSide === 'shop' ? 2 : findingSide === 'neither' ? 3 : findingSide === 'none' ? 0 : null,
  findingSide,
  paid,
  counterparty: '0x' + 'ee'.repeat(20),
  counterpartyName: 'Example Agent Co (sample)',
});

function fullCast(): CastBody {
  n = 0;
  return {
    registry,
    vaultToken: mock,
    degraded: [],
    members: [
      member('platform', 'Example Agent Co (sample)', ['personal-shopper', 'Personal shopping agent', 'Buys for one person within a spend limit (sample).'], { orders: 4, claims: [claim('closed_uncontested', 'platform', '12500000', 1), claim('settled', 'shop', '0', 2)] }),
      member('shop', 'Example Shop (sample)', ['apparel-sizes', 'Physical goods with sizes', 'Sells shirts in sizes (sample).'], { orders: 3, claims: [claim('closed_uncontested', 'platform', '12500000', 1)] }),
      member('platform', 'Example Buying Desk (sample)', ['procurement-approval', 'Procurement agent with buyer approval', 'Needs a buyer to approve above its limit (sample).'], { orders: 1 }),
      member('platform', 'Example Data Agent (sample)', ['data-buyer', 'Data agent paying per call', 'Buys API calls over x402 (sample).'], { orders: 2, claims: [claim('finding_made', 'none', null, 3)] }),
      member('shop', 'Example Pantry (sample)', ['perishable-goods', 'Perishable or time-bound goods', 'Refunds a late delivery (sample).'], { orders: 1, claims: [claim('expired', null, null, 4)] }),
      member('shop', 'Example API Shop (sample)', null, { ownerIsParty: false, agentURI: 'https://shop.example/.well-known/agent-registration.json' }),
    ],
  };
}

describe('the cast page', () => {
  it('shows every shop and agent company with its type, its ERC-8004 id, its orders and its claims', () => {
    const html = renderToString(<CastView d={fullCast()} />);
    expect(html).toContain('<h2>Shops (3)</h2>');
    expect(html).toContain('<h2>Agent companies (3)</h2>');
    for (const label of ['Personal shopping agent', 'Physical goods with sizes', 'Procurement agent with buyer approval', 'Data agent paying per call', 'Perishable or time-bound goods']) expect(html).toContain(label);
    expect(html).toContain('Buys for one person within a spend limit (sample).');
    // the id links to the registry on HashScan, as the API gives it
    expect(html).toContain(`href="${registry.explorer}"`);
    expect(html).toContain('>149<');
    // claims with their outcomes
    expect(html).toContain('2: 1 Closed, not contested, 1 Settled');
    expect(html).toContain('the agent company at fault');
    expect(html).toContain('paid 12.50 mUSDC (testnet mock)');
    expect(html).toContain('pre-check: no finding');
    expect(html).toContain('pre-check: not pre-checked yet');
    // a registration with no recourse object: shown with its role, type not stated
    expect(html).toContain('Type not stated');
    expect(html).toContain("(not the party&#x27;s own account)");
    expect(html).toContain('href="https://shop.example/.well-known/agent-registration.json"');
    expect(html).not.toContain('has not been registered yet');
    expect(html).not.toContain('could not be read just now');
  });

  it('says the cast has not been registered yet while there is one shop and one agent company', () => {
    const d = fullCast();
    const html = renderToString(<CastView d={{ ...d, members: d.members.slice(0, 2) }} />);
    expect(html).toContain('The demo cast has not been registered yet');
    expect(html).toContain('Example Shop (sample)');
    expect(renderToString(<CastView d={{ ...d, members: [] }} />)).toContain('None registered yet');
  });

  it('says when the registry could not be read, and shows the last values read', () => {
    const d = fullCast();
    const stale = d.members.map((m, i) => (i === 0 ? { ...m, current: false } : i === 1 ? { ...m, current: false, owner: null, ownerIsParty: null, agentURI: null, registration: null, readAt: null } : m));
    const html = renderToString(<CastView d={{ ...d, degraded: ['identity'], members: stale }} />);
    expect(html).toContain('could not be read just now');
    expect(html).toContain('as read <!-- -->2026-11-06');
    expect(html).toContain('The registration has not been read yet.');
    expect(html).toContain('not read yet');
  });

  it('is a route with a link in the main nav, and renders without a wallet', () => {
    expect(route('#/cast')).toEqual({ name: 'cast', arg: '' });
    const html = renderToString(<Shell hash="#/cast" />);
    expect(html).toContain('href="#/cast" aria-current="page"');
    expect(html).toContain('Shops and agents');
    expect(html).not.toContain('Connect wallet');
  });

  it('reads GET /v1/cast, documented as { cast, meta }, and unwraps it to the members and the freshness', () => {
    const spec = JSON.parse(readFileSync(new URL('../../../services/status-api/openapi.json', import.meta.url), 'utf8'));
    const schema = spec.paths[CAST_READ].get.responses['200'].content['application/json'].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['cast', 'meta']);
    expect(spec.components.schemas.Meta.properties.degraded.items.enum).toContain('identity');
    const meta = { apiVersion: '1', asOf: { hedera: 1, arbitrum: 2, hcs: 3 }, degraded: ['identity'], vaultToken: mock, configLock: { allLocked: false, notice: null } };
    const body = fromV1({ cast: { registry, members: [] }, meta }) as CastBody;
    expect(body.registry).toEqual(registry);
    expect(body.members).toEqual([]);
    expect(body.degraded).toEqual(['identity']);
  });
});
