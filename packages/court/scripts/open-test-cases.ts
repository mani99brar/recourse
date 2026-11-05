// Opens the trial cases on the public Kleros DisputeResolver (Arbitrum Sepolia) and posts their evidence.
//
//   tsx scripts/open-test-cases.ts [--case t1,t2,t3] [--send]
//
// Without --send it is a dry run: it reads the live cost, builds every template and evidence string,
// validates them and simulates the dispute creation from the ops-arb account. With --send, per case:
//   1. reads arbitrationCost(extraData) live and pays exactly that;
//   2. createDisputeForTemplate(extraData, template, "", 3);
//   3. reads the resolver's own evidence group id from its DisputeRequest log;
//   4. records the case in deployments/arbitrum.json under `testCases` at once (so a rerun never sends twice);
//   5. builds the evidence for that group id and submits it to the EvidenceModule.
// A case id already in `testCases` is never sent again.
//
// Env: ARB_RPC_URL, OPS_ARB_KEY_FILE (keystore path; password in the file next to it), DEPLOYMENTS_DIR.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { addressBook } from '@recourse/shared';
import { loadSigner } from '@recourse/shared/node';
import { POLICY } from '../src/policy.js';
import { TRIAL_CASES, buildTrialCase, trialEvidence } from '../src/trial.js';
import { validateTemplate } from '../src/validate.js';
import { PACKAGE_ROOT } from './fixtures.js';

const EXTRA_DATA = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [8n, 3n, 1n]);
const CHOICES = 3n;

const coreAbi = parseAbi(['function arbitrationCost(bytes _extraData) view returns (uint256)']);
const resolverAbi = parseAbi([
  'function createDisputeForTemplate(bytes _arbitratorExtraData, string _disputeTemplate, string _disputeTemplateDataMappings, uint256 _numberOfRulingOptions) payable returns (uint256)',
  'event DisputeRequest(address indexed _arbitrator, uint256 indexed _arbitratorDisputeID, uint256 _externalDisputeID, uint256 _templateId, string _templateUri)',
]);
const evidenceAbi = parseAbi([
  'function submitEvidence(uint256 _externalDisputeID, string _evidence)',
  'event Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence)',
]);

interface TestCaseRecord {
  caseId: string;
  variant: number;
  purpose: string;
  expectRuling: number;
  claimId: Hex;
  disputeId: string;
  externalId: string;
  templateId: string;
  cost: string;
  createTx: Hex;
  createdAt: string;
  policyURI: string;
  evidenceTx?: Hex;
  evidenceAt?: string;
  evidenceSha256?: Hex;
  courtUrl: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function outPath(): string {
  const dir = process.env.DEPLOYMENTS_DIR ?? join(PACKAGE_ROOT, '..', '..', 'deployments');
  return join(dir, 'arbitrum.json');
}

function readOut(path: string): Record<string, unknown> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
}

/** Rewrites only the `testCases` key, keeping every other key of the file. */
function writeTestCases(path: string, cases: TestCaseRecord[]): void {
  const doc = readOut(path);
  doc.testCases = cases;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const wanted = (arg('--case') ?? TRIAL_CASES.map((c) => c.id).join(',')).split(',');
  const defs = TRIAL_CASES.filter((c) => wanted.includes(c.id));
  if (defs.length !== wanted.length) throw new Error(`unknown case id in ${wanted.join(',')}`);

  const rpc = process.env.ARB_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';
  const book = addressBook.arbitrum;
  const account = loadSigner('OPS_ARB_KEY_FILE');
  const pub = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
  const wallet = createWalletClient({ chain: arbitrumSepolia, transport: http(rpc), account });
  if ((await pub.getChainId()) !== book.chainId) throw new Error('ARB_RPC_URL is not Arbitrum Sepolia');

  const path = outPath();
  const existing = (readOut(path).testCases as TestCaseRecord[] | undefined) ?? [];
  const balance = await pub.getBalance({ address: account.address });
  console.log(`ops-arb ${account.address} balance ${balance} wei; output ${path}`);

  for (const def of defs) {
    if (existing.some((c) => c.caseId === def.id)) {
      console.log(`${def.id}: already opened (${existing.find((c) => c.caseId === def.id)!.disputeId}); not sending again`);
      continue;
    }
    const built = buildTrialCase(def, POLICY.uri);
    const v = validateTemplate(built.template);
    if (!v.ok) throw new Error(`${def.id}: template fails validation: ${v.errors.join('; ')}`);
    trialEvidence(built, 0n); // fails here, before any send, if the evidence cannot be built
    const cost = await pub.readContract({ address: book.klerosCore, abi: coreAbi, functionName: 'arbitrationCost', args: [EXTRA_DATA] });
    const call = {
      address: book.disputeResolver as Address,
      abi: resolverAbi,
      functionName: 'createDisputeForTemplate' as const,
      args: [EXTRA_DATA, built.template, '', CHOICES] as const,
      value: cost,
      account,
    };

    if (!send) {
      try {
        // Simulated with a balance override, so the dry run proves the live resolver accepts the template
        // even before the ops account is funded.
        const sim = await pub.simulateContract({
          ...call,
          stateOverride: [{ address: account.address, balance: cost * 100n }],
        });
        const gas = await pub.estimateContractGas({
          ...call,
          stateOverride: [{ address: account.address, balance: cost * 100n }],
        });
        console.log(`${def.id}: dry run ok, would open dispute ${sim.result} for ${cost} wei, gas ${gas} (variant ${def.variant})`);
      } catch (e) {
        console.log(`${def.id}: dry run could not simulate (${(e as Error).message.split('\n')[0]}); cost ${cost} wei`);
      }
      continue;
    }

    const createTx = await wallet.writeContract(call);
    const receipt = await pub.waitForTransactionReceipt({ hash: createTx });
    if (receipt.status !== 'success') throw new Error(`${def.id}: createDisputeForTemplate reverted in ${createTx}`);
    const [req] = parseEventLogs({ abi: resolverAbi, eventName: 'DisputeRequest', logs: receipt.logs }).filter(
      (l) => l.address.toLowerCase() === book.disputeResolver.toLowerCase(),
    );
    if (req === undefined) throw new Error(`${def.id}: no DisputeRequest in ${createTx}`);
    const record: TestCaseRecord = {
      caseId: def.id,
      variant: def.variant,
      purpose: def.purpose,
      expectRuling: def.expectRuling,
      claimId: built.claimId,
      disputeId: req.args._arbitratorDisputeID.toString(),
      externalId: req.args._externalDisputeID.toString(),
      templateId: req.args._templateId.toString(),
      cost: cost.toString(),
      createTx,
      createdAt: now(),
      policyURI: POLICY.uri,
      courtUrl: `https://v2-testnet.kleros.builders/#/cases/${req.args._arbitratorDisputeID}/overview`,
    };
    existing.push(record);
    writeTestCases(path, existing);
    console.log(`${def.id}: dispute ${record.disputeId}, evidence group ${record.externalId}, tx ${createTx}`);

    const bundle = trialEvidence(built, req.args._externalDisputeID);
    const evidenceTx = await wallet.writeContract({
      address: book.evidenceModule,
      abi: evidenceAbi,
      functionName: 'submitEvidence',
      args: [req.args._externalDisputeID, bundle.evidence],
      account,
    });
    const er = await pub.waitForTransactionReceipt({ hash: evidenceTx });
    if (er.status !== 'success') throw new Error(`${def.id}: submitEvidence reverted in ${evidenceTx}`);
    record.evidenceTx = evidenceTx;
    record.evidenceAt = now();
    record.evidenceSha256 = bundle.sha256;
    writeTestCases(path, existing);
    console.log(`${def.id}: evidence ${bundle.byteLength} bytes in ${evidenceTx}`);
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
