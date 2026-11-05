// keeper-ctl: operator control of a running keeper. It writes only the control file in
// KEEPER_STATE_DIR (the keeper reads it every tick) and reads status over the loopback HTTP port.
//
//   keeper-ctl status [claimId]
//   keeper-ctl pause | resume
//   keeper-ctl hold <claimId> | release <claimId>
//   keeper-ctl window add <hedera|arbitrum>@<fromISO>/<toISO> | window list | window clear

import { parseSendPauseWindows, readEnv } from '@recourse/shared';
import { readControl, writeControl, type Control } from './control.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export interface CtlResult {
  code: number;
  out: string;
}

export async function runCtl(argv: readonly string[], env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): Promise<CtlResult> {
  const e = readEnv(['KEEPER_STATE_DIR', 'KEEPER_PORT'], { env });
  const dir = e.KEEPER_STATE_DIR;
  const [cmd, a1, a2] = argv;
  const edit = (fn: (c: Control) => string): CtlResult => {
    const c = readControl(dir);
    const out = fn(c);
    writeControl(dir, c);
    return { code: 0, out };
  };
  const claimArg = (v: string | undefined): string => {
    if (v === undefined || !HEX32.test(v)) throw new Error('give a claim id: 0x and 64 hex digits');
    return v.toLowerCase();
  };
  switch (cmd) {
    case 'status': {
      const path = a1 === undefined ? '/health' : `/claims/${claimArg(a1)}`;
      const res = await fetchFn(`http://127.0.0.1:${e.KEEPER_PORT}${path}`);
      const body = await res.text();
      const control = readControl(dir);
      return { code: res.ok ? 0 : 1, out: `${body}\ncontrol: ${JSON.stringify(control)}` };
    }
    case 'pause':
      return edit((c) => {
        c.paused = true;
        return 'paused: the keeper sends nothing until resume';
      });
    case 'resume':
      return edit((c) => {
        c.paused = false;
        return 'resumed';
      });
    case 'hold': {
      const id = claimArg(a1);
      return edit((c) => {
        c.holds[id] = Date.now();
        return `held ${id}`;
      });
    }
    case 'release': {
      const id = claimArg(a1);
      return edit((c) => {
        c.releases[id] = Date.now();
        return `released ${id} (operator hold and any hold the keeper set itself)`;
      });
    }
    case 'window': {
      if (a1 === 'list') return { code: 0, out: readControl(dir).windows.join('\n') || '(no windows in the control file)' };
      if (a1 === 'clear') {
        return edit((c) => {
          c.windows = [];
          return 'control-file windows cleared (SEND_PAUSE_WINDOWS still applies)';
        });
      }
      if (a1 === 'add' && a2 !== undefined) {
        parseSendPauseWindows(a2); // throws with the reason when malformed
        return edit((c) => {
          c.windows.push(a2);
          return `window added: ${a2}`;
        });
      }
      throw new Error('window add <hedera|arbitrum>@<fromISO>/<toISO> | window list | window clear');
    }
    default:
      return {
        code: 2,
        out: 'usage: keeper-ctl status [claimId] | pause | resume | hold <claimId> | release <claimId> | window add <chain@from/to> | window list | window clear',
      };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCtl(process.argv.slice(2))
    .then((r) => {
      process.stdout.write(`${r.out}\n`);
      process.exit(r.code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`keeper-ctl: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
