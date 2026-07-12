import { describe, expect, it } from "vitest";
import {
  CoordinatedKeyPool,
  LocalKeyPool,
  fingerprintKey,
  type AcquireDecision,
  type AcquireInput,
  type CoordinatorPort,
  type CredentialLease,
  type KeyPool,
  type QuarantineInput,
} from "../../src/key-pool.js";

class FakeClock {
  constructor(private ms: number) {}

  now(): number {
    return this.ms;
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

function apiKey(lease: CredentialLease): string {
  if (lease.mode !== "api-key") {
    throw new Error(`expected api-key lease, got ${lease.mode}`);
  }
  return lease.key;
}

describe("fingerprintKey", () => {
  it("returns the SHA-256 hex digest of the key bytes", async () => {
    const digest = await fingerprintKey("secret-key");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("secret-key");
    expect(digest).toBe(await fingerprintKey("secret-key"));
    expect(digest).not.toBe(await fingerprintKey("other-key"));
  });
});

describe("LocalKeyPool", () => {
  it("rotates globally ordered local leases", async () => {
    const pool = await LocalKeyPool.create(["a", "b", "c"]);
    expect(apiKey(await pool.acquire())).toBe("a");
    expect(apiKey(await pool.acquire())).toBe("b");
    expect(apiKey(await pool.acquire())).toBe("c");
    expect(apiKey(await pool.acquire())).toBe("a");
  });

  it("does not expose raw keys through fingerprints", async () => {
    const pool = await LocalKeyPool.create(["secret-key"]);
    const lease = await pool.acquire();
    expect(lease.fingerprint).not.toContain("secret-key");
  });

  it("skips a quarantined key and restores it after the deadline", async () => {
    const clock = new FakeClock(1_000);
    const pool = await LocalKeyPool.create(["a", "b"], {
      clock,
      quarantineMs: 10_000,
    });
    const first = await pool.acquire();
    await pool.reportAuthFailure(first.fingerprint);
    expect(apiKey(await pool.acquire())).toBe("b");
    clock.advance(10_001);
    expect(apiKey(await pool.acquire())).toBe("a");
  });

  it("returns a keyless lease when the pool is empty", async () => {
    const pool = await LocalKeyPool.create([]);
    const lease = await pool.acquire();
    expect(lease).toEqual({ mode: "keyless", fingerprint: "keyless" });
    // Second acquire stays keyless and does not invent a cursor.
    expect(await pool.acquire()).toEqual({ mode: "keyless", fingerprint: "keyless" });
  });

  it("resolve returns the matching lease without moving the cursor", async () => {
    const pool = await LocalKeyPool.create(["a", "b", "c"]);
    expect(apiKey(await pool.acquire())).toBe("a"); // nextIndex → 1

    const fingerprintB = await fingerprintKey("b");
    const resolved = await pool.resolve(fingerprintB);
    expect(resolved).toEqual({
      mode: "api-key",
      key: "b",
      fingerprint: fingerprintB,
    });

    // Cursor still at 1 → next acquire is "b", not advanced by resolve.
    expect(apiKey(await pool.acquire())).toBe("b");
  });

  it("resolve returns null for unknown fingerprints and keyless for the keyless sentinel", async () => {
    const empty = await LocalKeyPool.create([]);
    expect(await empty.resolve("keyless")).toEqual({
      mode: "keyless",
      fingerprint: "keyless",
    });
    expect(await empty.resolve("deadbeef")).toBeNull();

    const pool = await LocalKeyPool.create(["a"]);
    expect(await pool.resolve("keyless")).toBeNull();
    expect(await pool.resolve("unknown")).toBeNull();
  });

  it("fails with KEY_POOL_UNAVAILABLE when every key is quarantined", async () => {
    const clock = new FakeClock(0);
    const pool = await LocalKeyPool.create(["a", "b"], {
      clock,
      quarantineMs: 5_000,
    });
    const first = await pool.acquire(); // a, nextIndex → 1
    const second = await pool.acquire(); // b, nextIndex → 0
    await pool.reportAuthFailure(first.fingerprint);
    await pool.reportAuthFailure(second.fingerprint);

    await expect(pool.acquire()).rejects.toThrow("KEY_POOL_UNAVAILABLE");
  });

  it("does not advance the cursor after a failed acquisition", async () => {
    const clock = new FakeClock(0);
    const pool = await LocalKeyPool.create(["a", "b"], {
      clock,
      quarantineMs: 5_000,
    });
    // Force cursor to 1 by acquiring once, then quarantine both.
    const first = await pool.acquire(); // a, nextIndex → 1
    expect(apiKey(first)).toBe("a");
    const second = await pool.acquire(); // b, nextIndex → 0
    await pool.reportAuthFailure(first.fingerprint);
    await pool.reportAuthFailure(second.fingerprint);

    await expect(pool.acquire()).rejects.toThrow("KEY_POOL_UNAVAILABLE");

    // Cursor must still be 0 so after quarantine expires we resume at "a".
    clock.advance(5_001);
    expect(apiKey(await pool.acquire())).toBe("a");
  });

  it("reportAuthFailure is a no-op for unknown fingerprints", async () => {
    const pool = await LocalKeyPool.create(["a"]);
    await expect(pool.reportAuthFailure("missing")).resolves.toBeUndefined();
    expect(apiKey(await pool.acquire())).toBe("a");
  });

  it("never includes a raw key in public errors", async () => {
    const pool = await LocalKeyPool.create(["super-secret-key"], {
      quarantineMs: 1_000,
      now: () => 0,
    });
    const lease = await pool.acquire();
    await pool.reportAuthFailure(lease.fingerprint);

    try {
      await pool.acquire();
      throw new Error("expected acquire to throw");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-key");
      expect(message).toContain("KEY_POOL_UNAVAILABLE");
    }
  });

  it("implements the KeyPool surface", async () => {
    const pool: KeyPool = await LocalKeyPool.create(["a"]);
    const lease = await pool.acquire();
    expect(lease.mode).toBe("api-key");
    await pool.reportAuthFailure(lease.fingerprint);
    expect(await pool.resolve(lease.fingerprint)).not.toBeNull();
  });
});


class FakeCoordinator implements CoordinatorPort {
  public calls: AcquireInput[] = [];
  public quarantines: QuarantineInput[] = [];
  private cursor = 0;
  private quarantineUntil = new Map<string, number>();
  private decision: AcquireDecision | null = null;

  force(decision: AcquireDecision): void {
    this.decision = decision;
  }

  async acquireForTavily(input: AcquireInput): Promise<AcquireDecision> {
    this.calls.push(input);
    if (this.decision) return this.decision;
    if (input.fingerprints.length === 0) {
      return { allowed: false, code: "KEY_POOL_UNAVAILABLE" };
    }
    for (let offset = 0; offset < input.fingerprints.length; offset += 1) {
      const index = (this.cursor + offset) % input.fingerprints.length;
      const fingerprint = input.fingerprints[index]!;
      const until = this.quarantineUntil.get(fingerprint);
      if (until !== undefined && until > input.nowMs) continue;
      this.cursor = (index + 1) % input.fingerprints.length;
      return { allowed: true, fingerprint };
    }
    return { allowed: false, code: "KEY_POOL_UNAVAILABLE" };
  }

  async quarantine(input: QuarantineInput): Promise<void> {
    this.quarantines.push(input);
    this.quarantineUntil.set(input.fingerprint, input.untilMs);
  }
}

describe("CoordinatedKeyPool", () => {
  it("creates only with non-empty keys and never sends raw keys to coordinator", async () => {
    const coordinator = new FakeCoordinator();
    await expect(
      CoordinatedKeyPool.create([], coordinator, {
        quarantineMs: 1_000,
        tavilyDailyCallLimit: 10,
      }),
    ).rejects.toThrow("KEY_POOL_NOT_CONFIGURED");

    const pool = await CoordinatedKeyPool.create(["secret-a", "secret-b"], coordinator, {
      quarantineMs: 1_000,
      tavilyDailyCallLimit: 10,
      now: () => 1_000,
    });
    const lease = await pool.acquire();
    expect(lease.mode).toBe("api-key");
    expect(apiKey(lease)).toBe("secret-a");
    expect(coordinator.calls).toHaveLength(1);
    const payload = JSON.stringify(coordinator.calls[0]);
    expect(payload).not.toContain("secret-a");
    expect(payload).not.toContain("secret-b");
    expect(coordinator.calls[0]?.poolVersion).toBe(
      (await fingerprintKey("secret-a")) + "|" + (await fingerprintKey("secret-b")),
    );
  });

  it("maps coordinator denials to the same Error codes as LocalKeyPool", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.force({ allowed: false, code: "DAILY_LIMIT_REACHED" });
    const pool = await CoordinatedKeyPool.create(["a"], coordinator, {
      quarantineMs: 1_000,
      tavilyDailyCallLimit: 1,
    });
    await expect(pool.acquire()).rejects.toThrow("DAILY_LIMIT_REACHED");

    coordinator.force({ allowed: false, code: "KEY_POOL_UNAVAILABLE" });
    await expect(pool.acquire()).rejects.toThrow("KEY_POOL_UNAVAILABLE");
  });

  it("resolve is local and reportAuthFailure quarantines via coordinator", async () => {
    const coordinator = new FakeCoordinator();
    const pool = await CoordinatedKeyPool.create(["a", "b"], coordinator, {
      quarantineMs: 5_000,
      tavilyDailyCallLimit: 10,
      now: () => 100,
    });
    const fpA = await fingerprintKey("a");
    expect(await pool.resolve(fpA)).toEqual({
      mode: "api-key",
      key: "a",
      fingerprint: fpA,
    });
    expect(await pool.resolve("missing")).toBeNull();

    await pool.reportAuthFailure(fpA);
    expect(coordinator.quarantines).toEqual([{ fingerprint: fpA, untilMs: 5_100 }]);
    await pool.reportAuthFailure("missing");
    expect(coordinator.quarantines).toHaveLength(1);
  });
});
