import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { ReaiConfigError } from "../reai/errors.js";

/**
 * Sealed tokens: authenticated, encrypted, self-contained credentials.
 *
 * The server is its own OAuth authorization server, because ReAI itself issues
 * static API tokens rather than running an OAuth flow. Rather than keeping a
 * server-side session table, each token we mint *is* its own storage — the
 * user's ReAI token is encrypted into it with AES-256-GCM.
 *
 * That choice is what makes self-hosting practical: a Cloud Run service that
 * scales to zero, or runs several instances behind one URL, would otherwise drop
 * every session on each cold start and force the user to re-authorize
 * constantly. With sealed tokens any instance can serve any request, and there
 * is no database to operate or back up.
 *
 * The trade-off is that a sealed token cannot be revoked individually before it
 * expires. Rotating REAI_ENCRYPTION_KEY invalidates all of them at once, which
 * is the documented remedy.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Purposes are bound into the AEAD as additional authenticated data, so a token
 * minted for one role cannot be replayed as another — an access token presented
 * as a refresh token fails to decrypt rather than being accepted.
 */
export type TokenPurpose = "access" | "refresh" | "code" | "client" | "authreq";

const PREFIX: Record<TokenPurpose, string> = {
  access: "reaimcp_at",
  refresh: "reaimcp_rt",
  code: "reaimcp_ac",
  client: "reaimcp_cl",
  authreq: "reaimcp_rq",
};

/** True when a bearer value was minted by this server rather than by ReAI. */
export function isSealedToken(value: string): boolean {
  return Object.values(PREFIX).some((p) => value.startsWith(p + "."));
}

export class Sealer {
  private readonly key: Buffer;
  /** Set when the key was generated at boot rather than supplied. */
  readonly ephemeral: boolean;

  constructor(args: { key: Buffer; ephemeral: boolean }) {
    if (args.key.length !== KEY_BYTES) {
      throw new ReaiConfigError(
        `Encryption key must be exactly ${KEY_BYTES} bytes, got ${args.key.length}.`,
      );
    }
    this.key = args.key;
    this.ephemeral = args.ephemeral;
  }

  /**
   * Build from `REAI_ENCRYPTION_KEY`, accepting base64, base64url or hex.
   *
   * With no key configured we generate one so the server still starts, but every
   * previously issued token becomes undecryptable — callers should warn loudly.
   */
  static fromEnv(raw: string | undefined): Sealer {
    if (!raw || !raw.trim()) {
      return new Sealer({ key: randomBytes(KEY_BYTES), ephemeral: true });
    }
    const value = raw.trim();
    let key: Buffer | undefined;

    if (/^[0-9a-f]{64}$/i.test(value)) {
      key = Buffer.from(value, "hex");
    } else {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length === KEY_BYTES) key = decoded;
    }

    if (!key) {
      throw new ReaiConfigError(
        "REAI_ENCRYPTION_KEY must be 32 bytes, encoded as base64 (44 chars) or hex (64 chars). " +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
    return new Sealer({ key, ephemeral: false });
  }

  /** A stable, non-reversible fingerprint of the key, safe to log. */
  get keyFingerprint(): string {
    return createHash("sha256").update(this.key).digest("hex").slice(0, 12);
  }

  seal(purpose: TokenPurpose, payload: Record<string, unknown>, ttlSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds });

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const packed = Buffer.concat([iv, tag, ciphertext]).toString("base64url");
    return `${PREFIX[purpose]}.${packed}`;
  }

  /** Decrypt and validate. Returns undefined for any invalid or expired token. */
  unseal<T extends Record<string, unknown>>(
    purpose: TokenPurpose,
    token: string,
  ): (T & { iat: number; exp: number }) | undefined {
    const expectedPrefix = `${PREFIX[purpose]}.`;
    if (!token.startsWith(expectedPrefix)) return undefined;

    const packed = token.slice(expectedPrefix.length);
    let raw: Buffer;
    try {
      raw = Buffer.from(packed, "base64url");
    } catch {
      return undefined;
    }
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    let plaintext: string;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Wrong key, tampered ciphertext, or a token sealed for another purpose.
      return undefined;
    }

    let parsed: T & { iat: number; exp: number };
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return undefined;
    }

    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }
    return parsed;
  }
}

/** RFC 7636 S256 challenge check. `plain` is deliberately not supported. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return constantTimeEquals(computed, challenge);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length;
  // hashing first makes both sides a fixed 32 bytes.
  const hashA = createHash("sha256").update(bufA).digest();
  const hashB = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
