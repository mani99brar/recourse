// The agent's Hedera payer: its account id plus an SDK key built from the agent keystore. The key
// bytes are zeroed as soon as the SDK key exists.

import { PrivateKey } from '@hiero-ledger/sdk';
import { createClientHederaSigner, type ClientHederaSigner } from '@x402/hedera';
import { loadKeyBytes } from '@recourse/shared/node';
import { hederaAccountOf } from '@recourse/records';
import { NETWORK } from './x402-pay.js';

type Env = Record<string, string | undefined>;

export interface AgentPayer {
  accountId: string;
  source: string;
  signer: ClientHederaSigner;
  key: PrivateKey;
}

export function loadAgentPayer(env: Env = process.env): AgentPayer {
  const account = hederaAccountOf('agent', env);
  const bytes = loadKeyBytes('AGENT_KEY_FILE', env);
  let key: PrivateKey;
  try {
    key = PrivateKey.fromBytesECDSA(bytes);
  } finally {
    bytes.fill(0);
  }
  return {
    accountId: account.accountId,
    source: account.source,
    key,
    signer: createClientHederaSigner(account.accountId, key, { network: NETWORK }),
  };
}
