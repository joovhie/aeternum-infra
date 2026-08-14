import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Vault } from "@aeternum/db";

/**
 * Integration: batch boundary and failure isolation at scale.
 * MAX_CALLS_PER_TX in executor.ts is capped at 120, so any cycle with more
 * than 120 due wallets is split into multiple sequential transactions.
 * This test exercises that split with 125 confirmed-due wallets and verifies
 * that a single backup-address failure inside one batch does not affect
 * the other wallets in the same batch or in the following batch —
 * Multicall3's allowFailure: true is what makes this isolation possible.
 */

vi.mock("@aeternum/db", () => ({ getDueVaults: vi.fn() }));
vi.mock("@aeternum/blockchain", () => ({
  AETERNUM_VAULT_ABI: [],
  MULTICALL3_ABI: [],
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
}));
vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xcalldata"),
  parseEventLogs: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDueVaults } from "@aeternum/db";
import { parseEventLogs } from "viem";
import { scan } from "../../src/scanner.js";
import { execute } from "../../src/executor.js";
import { logger } from "../../src/logger.js";
import { createMockPublicClient, createMockWalletClient, createMockDb, makeAddresses } from "../helpers/mocks.js";
import { ONE_ETH } from "../fixtures/vaults.js";
import { failedLog, eventLogsByName } from "../fixtures/event-logs.js";
import { createReceipt, TX_HASH_1, TX_HASH_2 } from "../fixtures/receipts.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);
const mockParseEventLogs = vi.mocked(parseEventLogs);

/** Builds a minimal Vault row for a given address — scan() reads `.wallet`, not `.id`. */
function vaultRow(wallet: `0x${string}`): Vault {
  return {
    id: `${mockSharedEnv.CHAIN_ID}-${wallet}`,
    chainId: mockSharedEnv.CHAIN_ID,
    wallet,
    backupAddress: "0x0000000000000000000000000000000000000b" as `0x${string}`,
    inactivityPeriod: 31_536_000n,
    lastActivityTimestamp: 0n,
    isRecovered: false,
    isAbandoned: false,
    isCancelled: false,
    createdAtBlock: 1n,
  };
}

describe("integration: batch execution at scale with failure isolation", () => {
  let db: ReturnType<typeof createMockDb>;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;
  let wallets: `0x${string}`[];

  beforeEach(() => {
    db = createMockDb();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    wallets = makeAddresses(125); // Exceeds the 120 ceiling to force chunking

    mockGetDueVaults.mockResolvedValue(wallets.map(vaultRow));
    publicClient.multicall.mockResolvedValue(
      wallets.map(() => ({ status: "success", result: true })),
    );
  });

  it("scan confirms all 125 wallets as due", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(dueWallets).toHaveLength(125);
  });

  it("execute splits 125 confirmed wallets into batches of 120 and 5", async () => {
    walletClient.writeContract.mockResolvedValue(TX_HASH_1);
    publicClient.waitForTransactionReceipt.mockResolvedValue(createReceipt());
    mockParseEventLogs.mockReturnValue([]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    expect(walletClient.writeContract.mock.calls[0][0].args[0]).toHaveLength(120);
    expect(walletClient.writeContract.mock.calls[1][0].args[0]).toHaveLength(5);
  });

  it("every call entry in every batch carries allowFailure: true", async () => {
    walletClient.writeContract.mockResolvedValue(TX_HASH_1);
    publicClient.waitForTransactionReceipt.mockResolvedValue(createReceipt());
    mockParseEventLogs.mockReturnValue([]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    for (const call of walletClient.writeContract.mock.calls) {
      const batchCalls = call[0].args[0];
      for (const entry of batchCalls) {
        expect(entry.allowFailure).toBe(true);
      }
    }
  });

  it("a single failed transfer inside the first batch does not block the rest of that batch", async () => {
    walletClient.writeContract
      .mockResolvedValueOnce(TX_HASH_1)
      .mockResolvedValueOnce(TX_HASH_2);

    publicClient.waitForTransactionReceipt
      .mockResolvedValueOnce(createReceipt({ transactionHash: TX_HASH_1, logs: [{ fake: "log" }] }))
      .mockResolvedValueOnce(createReceipt({ transactionHash: TX_HASH_2, logs: [{ fake: "log" }] }));

    // First batch (120 wallets): 119 succeed, 1 fails.
    // Second batch (5 wallets): all 5 succeed.
    let parseCallCount = 0;
    mockParseEventLogs.mockImplementation(({ eventName }: any): any => {
      parseCallCount++;
      const isFirstBatch = parseCallCount <= 3; // 3 calls per batch (executed/failed/abandoned)

      if (isFirstBatch) {
        if (eventName === "RecoveryExecuted") {
          return Array.from({ length: 119 }, () => eventLogsByName("RecoveryExecuted")[0]);
        }
        if (eventName === "RecoveryFailed") return [failedLog];
        return [];
      }

      // Second batch — all succeed, none fail or abandon
      if (eventName === "RecoveryExecuted") {
        return Array.from({ length: 5 }, () => eventLogsByName("RecoveryExecuted")[0]);
      }
      return [];
    });

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    // First batch summary: 119 recovered, 1 failed
    expect(logger.info).toHaveBeenCalledWith(
      "Executor: batch confirmed",
      expect.objectContaining({ recovered: 119, failed: 1, abandoned: 0, submitted: 120 }),
    );

    // Second batch summary: 5 recovered, 0 failed — proves the second
    // batch's outcome is entirely unaffected by the first batch's failure
    expect(logger.info).toHaveBeenCalledWith(
      "Executor: batch confirmed",
      expect.objectContaining({ recovered: 5, failed: 0, abandoned: 0, submitted: 5 }),
    );

    // The single failure is still individually logged
    expect(logger.warn).toHaveBeenCalledWith(
      "Recovery failed — will retry next cycle",
      expect.objectContaining({ amount: ONE_ETH.toString() }),
    );
  });

  it("a batch submission failure does not prevent the next batch from being attempted", async () => {
    walletClient.writeContract
      .mockRejectedValueOnce(new Error("replacement transaction underpriced"))
      .mockResolvedValueOnce(TX_HASH_2);

    publicClient.waitForTransactionReceipt.mockResolvedValue(createReceipt({ transactionHash: TX_HASH_2 }));
    mockParseEventLogs.mockReturnValue([]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "Executor: batch submission failed",
      expect.objectContaining({ batch: 1, error: "replacement transaction underpriced" }),
    );
    // Second batch still completed successfully despite the first batch's failure
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("logs the total wallet and batch counts before submission begins", async () => {
    walletClient.writeContract.mockResolvedValue(TX_HASH_1);
    publicClient.waitForTransactionReceipt.mockResolvedValue(createReceipt());
    mockParseEventLogs.mockReturnValue([]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).toHaveBeenCalledWith(
      "Executor: beginning execution",
      { totalWallets: 125, totalBatches: 2 },
    );
  });
});