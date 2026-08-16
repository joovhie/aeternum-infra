import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validProcessEnv,
  validProcessEnvNoPrefix,
  invalidEnvCases,
  envWithOverrides,
  mockSharedEnv,
} from "../fixtures/env.js";

/**
 * TESTING STRATEGY
 * ─────────────────────────────────────────────────────────────────────────
 * src/index.ts runs side effects at module-evaluation time: it validates
 * env, instantiates clients, starts an HTTP server, and launches an async
 * polling IIFE that never resolves under normal operation. To test it:
 *
 *   1. All dependencies are mocked via vi.hoisted() refs so each test can
 *      configure return values BEFORE the dynamic import evaluates index.ts.
 *   2. node:http is mocked to capture the request handler without binding
 *      a real port.
 *   3. global setTimeout is mocked so the "sleep" between polling cycles
 *      resolves immediately AND emits SIGTERM, deterministically stopping
 *      the loop after exactly one cycle instead of running forever.
 *   4. vi.resetModules() + dynamic import() runs index.ts fresh per test.
 *   5. process listeners and global setTimeout are restored in afterEach
 *      to prevent leakage into subsequent tests.
 */

const hoisted = vi.hoisted(() => ({
  httpListen:  vi.fn((_port: number, cb?: () => void) => cb?.()),
  httpClose:   vi.fn(),
  httpHandler: { current: null as ((req: any, res: any) => void) | null },

  scan:    vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(undefined),

  createViemPublicClient: vi.fn().mockReturnValue({ __type: "publicClient" }),
  createViemWalletClient: vi.fn().mockReturnValue({ __type: "walletClient" }),
  createDbClient:         vi.fn().mockReturnValue({ __type: "dbClient" }),

  logger: {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn((handler: (req: any, res: any) => void) => {
      hoisted.httpHandler.current = handler;
      return { listen: hoisted.httpListen, close: hoisted.httpClose };
    }),
  },
}));

vi.mock("@aeternum/config", () => ({
  env: mockSharedEnv,
  KEEPER_DEFAULTS: { POLL_INTERVAL_MS: 60_000, BATCH_SIZE: 1_000 },
}));

vi.mock("@aeternum/blockchain", () => ({
  createViemPublicClient: hoisted.createViemPublicClient,
  createViemWalletClient: hoisted.createViemWalletClient,
}));

vi.mock("@aeternum/db", () => ({
  createDbClient: hoisted.createDbClient,
}));

vi.mock("../../src/scanner.js", () => ({ scan: hoisted.scan }));
vi.mock("../../src/executor.js", () => ({ execute: hoisted.execute }));
vi.mock("../../src/logger.js", () => ({ logger: hoisted.logger }));

// --- Helpers ---

let exitSpy: ReturnType<typeof vi.spyOn>;
let originalSetTimeout: typeof setTimeout;

/**
 * Replaces process.env with the given object, resets modules, and
 * dynamically imports index.ts. The mocked setTimeout fires SIGTERM on
 * its first invocation so the polling loop runs exactly one cycle then
 * shuts down — keeping every test deterministic and fast.
 */
async function importIndexFresh(envVars: Record<string, string | undefined>) {
  process.env = { ...envVars } as NodeJS.ProcessEnv;

  vi.stubGlobal(
    "setTimeout",
    ((fn: () => void) => {
      process.emit("SIGTERM" as any);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
  );

  vi.resetModules();
  await import("../../src/index.js");

  // Flush the microtask queue so the polling IIFE's first cycle completes
  // before assertions run.
  await vi.waitFor(() => expect(hoisted.scan).toHaveBeenCalled(), { timeout: 1000 });
}

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    // Throw an error to physically halt module evaluation for failure exits
    if (code !== 0) throw new Error(`Mock process.exit called with ${code}`);
    return undefined as never;
  });
  originalSetTimeout = global.setTimeout;
});

afterEach(() => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  global.setTimeout = originalSetTimeout;
});

// --- Keeper env schema validation ---

describe("index.ts — keeper env validation", () => {
  it("exits with code 1 when KEEPER_PRIVATE_KEY is missing", async () => {
    await importIndexFreshInvalid(invalidEnvCases.missingPrivateKey);
    expect(hoisted.logger.error).toHaveBeenCalledWith(
      "Invalid keeper environment variables",
      expect.objectContaining({ errors: expect.anything() }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when KEEPER_PRIVATE_KEY is too short", async () => {
    await importIndexFreshInvalid(invalidEnvCases.tooShortWithPrefix);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when KEEPER_PRIVATE_KEY contains non-hex characters", async () => {
    await importIndexFreshInvalid(invalidEnvCases.nonHexChars);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when KEEPER_PRIVATE_KEY is an empty string", async () => {
    await importIndexFreshInvalid(invalidEnvCases.emptyString);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not start the health server when validation fails", async () => {
    await importIndexFreshInvalid(invalidEnvCases.missingPrivateKey);
    expect(hoisted.httpListen).not.toHaveBeenCalled();
  });

  it("accepts a 0x-prefixed private key", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(hoisted.createViemWalletClient).toHaveBeenCalled();
  });

  it("accepts a private key without a 0x prefix and normalises it before client creation", async () => {
    await importIndexFresh(validProcessEnvNoPrefix);

    const [, , keyArg] = hoisted.createViemWalletClient.mock.calls[0];
    expect(keyArg.startsWith("0x")).toBe(true);
    expect(keyArg).toHaveLength(66); // 0x + 64 hex chars
  });

  it("applies default poll interval and batch size when overrides are not set", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.logger.info).toHaveBeenCalledWith(
      "Keeper: starting",
      expect.objectContaining({ pollIntervalMs: 60_000, batchSize: 1_000 }),
    );
  });

  it("applies KEEPER_POLL_INTERVAL_MS and KEEPER_BATCH_SIZE overrides when set", async () => {
    await importIndexFresh(envWithOverrides);

    expect(hoisted.logger.info).toHaveBeenCalledWith(
      "Keeper: starting",
      expect.objectContaining({ pollIntervalMs: 30_000, batchSize: 500 }),
    );
  });
});

/**
 * For invalid-env cases, index.ts calls process.exit(1) synchronously
 * during module evaluation and never reaches the polling loop — so the
 * scan-based waitFor used by importIndexFresh would hang. This variant
 * skips that wait and safely catches the simulated process termination error.
 */
async function importIndexFreshInvalid(envVars: Record<string, string | undefined>) {
  process.env = { ...envVars } as NodeJS.ProcessEnv;
  vi.resetModules();
  
  try {
    await import("../../src/index.js");
  } catch (err: any) {
    // Swallow our intentional halt, but re-throw if it's a real bug (like the TypeError)
    if (!err.message?.includes("Mock process.exit")) {
      throw err;
    }
  }
}

// --- Client instantiation ---

describe("index.ts — client instantiation", () => {
  it("creates the public client with RPC_URL and CHAIN_ID from shared env", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.createViemPublicClient).toHaveBeenCalledWith(
      mockSharedEnv.RPC_URL,
      mockSharedEnv.CHAIN_ID,
    );
  });

  it("creates the DB client with DATABASE_URL from shared env", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.createDbClient).toHaveBeenCalledWith(mockSharedEnv.DATABASE_URL);
  });
});

// --- Health server ---

describe("index.ts — health server", () => {
  it("starts listening on port 3001 when PORT is not set", async () => {
    const { PORT: _omit, ...rest } = validProcessEnv as Record<string, string>;
    await importIndexFresh(rest);

    expect(hoisted.httpListen).toHaveBeenCalledWith(3001, expect.any(Function));
  });

  it("starts listening on the PORT env var when set", async () => {
    await importIndexFresh({ ...validProcessEnv, PORT: "8080" } as Record<string, string>);

    expect(hoisted.httpListen).toHaveBeenCalledWith(8080, expect.any(Function));
  });

  it("GET /health responds 200 with {status: ok}", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    const writeHead = vi.fn();
    const end = vi.fn();
    hoisted.httpHandler.current?.(
      { url: "/health", method: "GET" },
      { writeHead, end },
    );

    expect(writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ status: "ok" }));
  });

  it("unknown routes respond 404", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    const writeHead = vi.fn();
    const end = vi.fn();
    hoisted.httpHandler.current?.(
      { url: "/unknown", method: "GET" },
      { writeHead, end },
    );

    expect(writeHead).toHaveBeenCalledWith(404);
  });

  it("POST /health responds 404 (method not allowed)", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    const writeHead = vi.fn();
    const end = vi.fn();
    hoisted.httpHandler.current?.(
      { url: "/health", method: "POST" },
      { writeHead, end },
    );

    expect(writeHead).toHaveBeenCalledWith(404);
  });
});

// --- Polling cycle ---

describe("index.ts — keeper cycle", () => {
  it("calls scan with db, publicClient, contractAddress, and the batch size", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.scan).toHaveBeenCalledWith(
      { __type: "dbClient" },
      mockSharedEnv.CHAIN_ID,
      { __type: "publicClient" },
      mockSharedEnv.CONTRACT_ADDRESS,
      1_000,
    );
  });

  it("does not call execute when scan returns an empty array", async () => {
    hoisted.scan.mockResolvedValueOnce([]);

    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.execute).not.toHaveBeenCalled();
    expect(hoisted.logger.info).toHaveBeenCalledWith("Keeper: no due vaults found this cycle");
  });

  it("calls execute with the wallets returned by scan", async () => {
    const wallets = ["0x0000000000000000000000000000000000000001"] as const;
    hoisted.scan.mockResolvedValueOnce([...wallets]);

    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.execute).toHaveBeenCalledWith(
      { __type: "walletClient" },
      { __type: "publicClient" },
      mockSharedEnv.CONTRACT_ADDRESS,
      [...wallets],
    );
  });

  it("logs an unhandled cycle error without crashing when scan throws", async () => {
    hoisted.scan.mockRejectedValueOnce(new Error("scan exploded"));

    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.logger.error).toHaveBeenCalledWith(
      "Keeper: unhandled cycle error",
      expect.objectContaining({ error: "scan exploded" }),
    );
  });

  it("stringifies a non-Error thrown value in the unhandled cycle error log", async () => {
    hoisted.scan.mockRejectedValueOnce("a plain string was thrown");

    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.logger.error).toHaveBeenCalledWith(
      "Keeper: unhandled cycle error",
      { error: "a plain string was thrown", stack: undefined },
    );
  });
});

// --- Graceful shutdown ---

describe("index.ts — graceful shutdown", () => {
  it("closes the health server and exits 0 after SIGTERM stops the loop", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    // importIndexFresh's mocked setTimeout already triggered SIGTERM and
    // let the loop run to completion — verify the resulting shutdown sequence.
    expect(hoisted.logger.info).toHaveBeenCalledWith("Keeper: shutdown complete");
    expect(hoisted.httpClose).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs receipt of SIGTERM before stopping", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    expect(hoisted.logger.info).toHaveBeenCalledWith(
      "Keeper: SIGTERM received — will stop after current cycle",
    );
  });

  it("breaks the loop immediately if SIGTERM is received during an active cycle", async () => {
    // Force a mid-cycle shutdown by making scan() emit SIGTERM
    hoisted.scan.mockImplementationOnce(async () => {
      process.emit("SIGTERM" as any);
      return [];
    });

    await importIndexFresh(validProcessEnv as Record<string, string>);

    // The loop should hit `if (!running) break;` and exit without hitting setTimeout
    expect(hoisted.logger.info).toHaveBeenCalledWith("Keeper: shutdown complete");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("index.ts — SIGINT shutdown", () => {
  it("closes the health server and exits 0 immediately on SIGINT", async () => {
    await importIndexFresh(validProcessEnv as Record<string, string>);

    // importIndexFresh already drove a SIGTERM-triggered shutdown to
    // completion. Clear those calls so we isolate SIGINT's own effect.
    hoisted.httpClose.mockClear();
    exitSpy.mockClear();
    hoisted.logger.info.mockClear();

    process.emit("SIGINT" as any);

    expect(hoisted.logger.info).toHaveBeenCalledWith(
      "Keeper: SIGINT received — stopping",
    );
    expect(hoisted.httpClose).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});