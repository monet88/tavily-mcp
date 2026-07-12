export type CredentialLease =
  | { mode: "api-key"; key: string; fingerprint: string }
  | { mode: "keyless"; fingerprint: "keyless" };

export interface KeyPool {
  acquire(): Promise<CredentialLease>;
  resolve(fingerprint: string): Promise<CredentialLease | null>;
  reportAuthFailure(fingerprint: string): Promise<void>;
}

export interface PoolOptions {
  now?: () => number;
  quarantineMs: number;
}

export interface AcquireInput {
  poolVersion: string;
  fingerprints: string[];
  nowMs: number;
  tavilyDailyCallLimit: number;
}

export type AcquireDecision =
  | { allowed: true; fingerprint: string }
  | { allowed: false; code: "DAILY_LIMIT_REACHED" | "KEY_POOL_UNAVAILABLE" };

export interface QuarantineInput {
  fingerprint: string;
  untilMs: number;
}

export interface CoordinatorPort {
  acquireForTavily(input: AcquireInput): Promise<AcquireDecision>;
  quarantine(input: QuarantineInput): Promise<void>;
}

// Matches design default KEY_QUARANTINE_SECONDS = 600.
const DEFAULT_QUARANTINE_MS = 600_000;

interface KeyEntry {
  key: string;
  fingerprint: string;
}

/** Fingerprinted pool material shared across CoordinatedKeyPool instances. */
export interface PreparedKeyMaterial {
  entries: readonly KeyEntry[];
  byFingerprint: ReadonlyMap<string, string>;
  fingerprints: readonly string[];
  poolVersion: string;
  /** Stable identity for isolate-level cache (raw keys stay in isolate only). */
  cacheKey: string;
}

// clock is accepted for tests (FakeClock); production uses now() or Date.now.
export type LocalPoolCreateOptions = Partial<PoolOptions> & {
  clock?: { now(): number };
};

export async function fingerprintKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function prepareKeyMaterial(keys: string[]): Promise<PreparedKeyMaterial> {
  if (keys.length === 0) {
    throw new Error("KEY_POOL_NOT_CONFIGURED");
  }
  const entries: KeyEntry[] = [];
  const byFingerprint = new Map<string, string>();
  for (const key of keys) {
    const fingerprint = await fingerprintKey(key);
    if (byFingerprint.has(fingerprint)) continue;
    entries.push({ key, fingerprint });
    byFingerprint.set(fingerprint, key);
  }
  const fingerprints = entries.map(entry => entry.fingerprint);
  return {
    entries,
    byFingerprint,
    fingerprints,
    poolVersion: fingerprints.join("|"),
    cacheKey: JSON.stringify(keys),
  };
}

export class LocalKeyPool implements KeyPool {
  private nextIndex = 0;
  private readonly quarantineUntil = new Map<string, number>();

  private constructor(
    private readonly entries: readonly KeyEntry[],
    private readonly now: () => number,
    private readonly quarantineMs: number,
  ) {}

  static async create(
    keys: string[],
    options: LocalPoolCreateOptions = {},
  ): Promise<LocalKeyPool> {
    const entries: KeyEntry[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const fingerprint = await fingerprintKey(key);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      entries.push({ key, fingerprint });
    }
    const now =
      options.now ??
      (options.clock ? () => options.clock!.now() : () => Date.now());
    const quarantineMs = options.quarantineMs ?? DEFAULT_QUARANTINE_MS;
    return new LocalKeyPool(entries, now, quarantineMs);
  }

  async acquire(): Promise<CredentialLease> {
    if (this.entries.length === 0) {
      return { mode: "keyless", fingerprint: "keyless" };
    }

    const nowMs = this.now();
    const count = this.entries.length;

    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.nextIndex + offset) % count;
      const entry = this.entries[index]!;
      if (this.isQuarantined(entry.fingerprint, nowMs)) continue;

      // Advance only after a successful selection.
      this.nextIndex = (index + 1) % count;
      return {
        mode: "api-key",
        key: entry.key,
        fingerprint: entry.fingerprint,
      };
    }

    // All keys quarantined — cursor must not move.
    throw new Error("KEY_POOL_UNAVAILABLE");
  }

  async resolve(fingerprint: string): Promise<CredentialLease | null> {
    if (fingerprint === "keyless") {
      return this.entries.length === 0
        ? { mode: "keyless", fingerprint: "keyless" }
        : null;
    }
    const entry = this.entries.find(item => item.fingerprint === fingerprint);
    if (!entry) return null;
    return {
      mode: "api-key",
      key: entry.key,
      fingerprint: entry.fingerprint,
    };
  }

  async reportAuthFailure(fingerprint: string): Promise<void> {
    if (!this.entries.some(entry => entry.fingerprint === fingerprint)) {
      return;
    }
    this.quarantineUntil.set(fingerprint, this.now() + this.quarantineMs);
  }

  private isQuarantined(fingerprint: string, nowMs: number): boolean {
    const until = this.quarantineUntil.get(fingerprint);
    if (until === undefined) return false;
    if (until <= nowMs) {
      this.quarantineUntil.delete(fingerprint);
      return false;
    }
    return true;
  }
}

export type CoordinatedPoolCreateOptions = Partial<PoolOptions> & {
  /** Required for acquireForTavily daily limit checks. */
  tavilyDailyCallLimit: number;
  clock?: { now(): number };
};

/**
 * Worker-side pool: raw keys stay in isolate memory; only fingerprints go to the DO.
 */
export class CoordinatedKeyPool implements KeyPool {
  private constructor(
    private readonly entries: readonly KeyEntry[],
    private readonly byFingerprint: ReadonlyMap<string, string>,
    private readonly fingerprints: readonly string[],
    private readonly poolVersion: string,
    private readonly coordinator: CoordinatorPort,
    private readonly now: () => number,
    private readonly quarantineMs: number,
    private readonly tavilyDailyCallLimit: number,
  ) {}

  static async create(
    keys: string[],
    coordinator: CoordinatorPort,
    options: CoordinatedPoolCreateOptions,
  ): Promise<CoordinatedKeyPool> {
    const material = await prepareKeyMaterial(keys);
    return CoordinatedKeyPool.fromMaterial(material, coordinator, options);
  }

  /** Reuse pre-fingerprinted material (avoids re-hashing every Worker request). */
  static fromMaterial(
    material: PreparedKeyMaterial,
    coordinator: CoordinatorPort,
    options: CoordinatedPoolCreateOptions,
  ): CoordinatedKeyPool {
    const now =
      options.now ??
      (options.clock ? () => options.clock!.now() : () => Date.now());
    return new CoordinatedKeyPool(
      material.entries,
      material.byFingerprint,
      material.fingerprints,
      material.poolVersion,
      coordinator,
      now,
      options.quarantineMs ?? DEFAULT_QUARANTINE_MS,
      options.tavilyDailyCallLimit,
    );
  }

  async acquire(): Promise<CredentialLease> {
    const decision = await this.coordinator.acquireForTavily({
      poolVersion: this.poolVersion,
      fingerprints: [...this.fingerprints],
      nowMs: this.now(),
      tavilyDailyCallLimit: this.tavilyDailyCallLimit,
    });
    if (!decision.allowed) {
      throw new Error(decision.code);
    }
    const key = this.byFingerprint.get(decision.fingerprint);
    if (!key) {
      // Pool drifted vs coordinator selection — treat as unavailable.
      throw new Error("KEY_POOL_UNAVAILABLE");
    }
    return {
      mode: "api-key",
      key,
      fingerprint: decision.fingerprint,
    };
  }

  async resolve(fingerprint: string): Promise<CredentialLease | null> {
    const key = this.byFingerprint.get(fingerprint);
    if (!key) return null;
    return { mode: "api-key", key, fingerprint };
  }

  async reportAuthFailure(fingerprint: string): Promise<void> {
    if (!this.byFingerprint.has(fingerprint)) return;
    await this.coordinator.quarantine({
      fingerprint,
      untilMs: this.now() + this.quarantineMs,
    });
  }
}

