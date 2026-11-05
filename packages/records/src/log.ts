// One-line JSON logs on stdout/stderr. Callers pass ids, amounts and tx ids only; never a key,
// a password, a salt or free text from another party.

export type LogFields = Record<string, string | number | boolean | null | undefined | bigint>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function line(service: string, level: string, event: string, fields: LogFields = {}): string {
  const out: Record<string, unknown> = { t: new Date().toISOString(), service, level, event };
  for (const [k, v] of Object.entries(fields)) out[k] = typeof v === 'bigint' ? v.toString() : v;
  return JSON.stringify(out);
}

export function createLogger(service: string): Logger {
  return {
    info: (event, fields) => console.log(line(service, 'info', event, fields)),
    warn: (event, fields) => console.warn(line(service, 'warn', event, fields)),
    error: (event, fields) => console.error(line(service, 'error', event, fields)),
  };
}

/** Logger that keeps lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: { level: string; event: string; fields: LogFields }[] } {
  const lines: { level: string; event: string; fields: LogFields }[] = [];
  const push = (level: string) => (event: string, fields: LogFields = {}) => lines.push({ level, event, fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
