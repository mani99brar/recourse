// Intake configuration. Intake reads no key files: the only secret it may hold is the LLM key.

type Env = Record<string, string | undefined>;

export interface IntakeConfig {
  port: number;
  corsOrigin: string | undefined;
  maxBytes: number;
  ratePerMin: number;
  llmApiKey: string | undefined;
  llmModel: string;
  llmUrl: string;
  llmTimeoutMs: number;
  llmPauseMin: number;
  stateDir: string;
}

function num(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name}: expected a number of at least ${min}`);
  return n;
}

export function loadConfig(env: Env = process.env): IntakeConfig {
  return {
    port: num(env, 'INTAKE_PORT', 8716, 1),
    corsOrigin: env.INTAKE_CORS_ORIGIN || undefined,
    maxBytes: num(env, 'INTAKE_MAX_BYTES', 65536, 1024),
    ratePerMin: num(env, 'INTAKE_RATE_PER_MIN', 10, 1),
    llmApiKey: env.LLM_API_KEY || undefined,
    llmModel: env.LLM_MODEL || '',
    llmUrl: 'https://openrouter.ai/api/v1/chat/completions',
    llmTimeoutMs: num(env, 'INTAKE_LLM_TIMEOUT_MS', 20000, 100),
    llmPauseMin: num(env, 'INTAKE_LLM_PAUSE_MIN', 30, 1),
    stateDir: env.INTAKE_STATE_DIR || `${env.HOME ?? '.'}/.local/state/recourse/intake`,
  };
}
