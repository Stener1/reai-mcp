import { DEFAULT_BASE_URL } from "./reai/client.js";
import { ReaiConfigError } from "./reai/errors.js";
import type { WriteMode } from "./policy.js";
import { parseWriteMode } from "./policy.js";

export type ServerConfig = {
  baseUrl: string;
  /** Absent in remote mode, where each session supplies its own token. */
  token: string | undefined;
  defaultTenantId: number | undefined;
  writeMode: WriteMode;
  timeoutMs: number;
  maxRetries: number;
  /** Log one line per API request to stderr. Never logs tokens. */
  verbose: boolean;
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ReaiConfigError(`${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env.REAI_USER_API_TOKEN?.trim() || env.REAI_TOKEN?.trim() || undefined;

  let defaultTenantId: number | undefined;
  const rawTenant = env.REAI_TENANT_ID?.trim();
  if (rawTenant) {
    const n = Number(rawTenant);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ReaiConfigError(
        `REAI_TENANT_ID must be a positive integer tenant id (see reai_whoami), got "${rawTenant}".`,
      );
    }
    defaultTenantId = n;
  }

  return {
    baseUrl: (env.REAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token,
    defaultTenantId,
    writeMode: parseWriteMode(env.REAI_WRITE_MODE),
    timeoutMs: intFromEnv("REAI_TIMEOUT_MS", 30_000),
    maxRetries: intFromEnv("REAI_MAX_RETRIES", 2),
    verbose: env.REAI_VERBOSE === "1" || env.REAI_VERBOSE === "true",
  };
}
