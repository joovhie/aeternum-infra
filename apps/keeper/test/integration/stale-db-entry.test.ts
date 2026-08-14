import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration: indexer lag.
 * The DB may lag a few blocks behind the chain head — a vault can appear
 * "due" in the indexed snapshot when the user actually pinged or deposited
 * moments earlier. The onchain validation layer (isRecoveryDue via
 * multicall) is the safety net that catches this before any transaction
 * is ever submitted.
 */

vi.mock("@aeternum/db", () => ({ getDueVaults: vi.fn() }));
vi.mock("@aeternum/blockchain", () => ({
  AETERNUM_VAULT_ABI: [],
  MULTICALL3_ABI: [],
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
}));
vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xcalldata"),
  parseEventLogs: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDueVaults } from "@aeternum/db";
import { scan } from "../../src/scanner.js";
import { execute } from "../../src/executor.js";
import { logger } from "../../src/logger.js";
import { createMockPublicClient, createMockWalletClient, createMockDb } from "../helpers/mocks.js";
import { dueVault, activeVault, mixedVaults, WALLET_A, WALLET_B } from "../fixtures/vaults.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);

describe("integration: stale DB entry is filtered before execution", () => {
  let db: ReturnType<typeof createMockDb>;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    db = createMockDb();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
  });

  it("DB returns a vault as due, but onchain check says it is no longer due — scan excludes it", async () => {
    mockGetDueVaults.mockResolvedValue([dueVault]); // DB thinks WALLET_A is due
    publicClient.multicall.mockResolvedValue([{ status: "success", result: false }]); // user pinged since

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(dueWallets).toEqual([]);
  });

  it("a stale entry never reaches the executor — no transaction is submitted", async () => {
    mockGetDueVaults.mockResolvedValue([dueVault]);
    publicClient.multicall.mockResolvedValue([{ status: "success", result: false }]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    if (dueWallets.length > 0) {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);
    }

    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("logs the stale-entry count for observability", async () => {
    mockGetDueVaults.mockResolvedValue([dueVault]);
    publicClient.multicall.mockResolvedValue([{ status: "success", result: false }]);

    await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(logger.info).toHaveBeenCalledWith(
      "Scanner: stale DB entries filtered out",
      { stale: 1 },
    );
  });

  it("mixed batch: a genuinely due wallet proceeds while a stale one is filtered out", async () => {
    // dueVault (WALLET_A) confirmed onchain; activeVault (WALLET_B) is stale —
    // the DB hadn't yet caught up to the user's recent ping.
    mockGetDueVaults.mockResolvedValue(mixedVaults);
    publicClient.multicall.mockResolvedValue([
      { status: "success", result: true },  // WALLET_A — genuinely due
      { status: "success", result: false }, // WALLET_B — stale, user pinged
    ]);
    walletClient.writeContract.mockResolvedValue("0xtxhash" as `0x${string}`);
    publicClient.waitForTransactionReceipt.mockResolvedValue({
      blockNumber: 1n, gasUsed: 91_000n, logs: [], transactionHash: "0xtxhash", status: "success",
    });

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    expect(dueWallets).toEqual([WALLET_A]);

    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    // Only one wallet (WALLET_A) ever reaches the executor
    const submittedCall = walletClient.writeContract.mock.calls[0][0];
    expect(submittedCall.args[0]).toHaveLength(1);
  });

  it("a failed RPC call during onchain validation discards all DB candidates for that cycle", async () => {
    mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
    publicClient.multicall.mockRejectedValue(new Error("RPC node unavailable"));

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(dueWallets).toEqual([]);
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Scanner: onchain validation failed, skipping cycle",
      expect.objectContaining({ error: "RPC node unavailable" }),
    );
  });
});