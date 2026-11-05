// Local chain for tests: one anvil on a port in this service's range (8570-8579), with the Hedera
// contracts deployed by the repo's local deploy script (mocks for HTS, PRNG and the USDC facade).
// Uses anvil's public development accounts only; no keys are read. Callers run under the suite lock.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mnemonicToAccount } from 'viem/accounts';
import { readHederaDeployment, type HederaDeployment } from '../src/chain.js';

const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));
/** Anvil's well-known development mnemonic: test funds only. */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

export function devAccount(index: number) {
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
}

export interface LocalChain {
  rpcUrl: string;
  file: string;
  deployment: HederaDeployment;
  rpc<T>(method: string, params?: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export async function startLocalChain(port: number): Promise<LocalChain> {
  if (port < 8570 || port > 8579) throw new Error('anvil: use a port in 8570-8579');
  const bin = join(homedir(), '.local', 'bin');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(join(bin, 'anvil'), ['--port', String(port), '--silent'], { env, stdio: 'ignore' });
  const stop = async () => {
    if (anvil.exitCode === null) {
      anvil.kill('SIGTERM');
      await new Promise((r) => anvil.once('exit', r));
    }
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await rpcCall(rpcUrl, 'eth_chainId');
        break;
      } catch {
        if (i > 100) throw new Error('anvil did not start');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const file = `hedera.lane04-test-${port}.local.json`;
    const run = spawnSync(
      join(bin, 'forge'),
      ['script', 'script/hedera/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', DEPLOYER],
      { cwd: CONTRACTS, env: { ...env, HEDERA_LOCAL_FILE: file }, encoding: 'utf8', timeout: 600_000 },
    );
    if (run.status !== 0) throw new Error(`local deploy failed: ${(run.stderr || run.stdout).slice(-2000)}`);
    const deployment = readHederaDeployment({ file, env: { DEPLOYMENTS_DIR: DEPLOYMENTS } });
    return {
      rpcUrl,
      file,
      deployment,
      rpc: (method, params) => rpcCall(rpcUrl, method, params),
      stop: async () => {
        await stop();
        rmSync(join(DEPLOYMENTS, file), { force: true });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
