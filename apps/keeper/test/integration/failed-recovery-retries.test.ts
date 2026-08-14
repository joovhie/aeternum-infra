import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration: backup address rejects ETH.
 * The contract's _executeRecovery restores state on a failed transfer and
 * increments failedRecoveryAttempts — the vault remains active and will
 * surface again in a future scan() cycle. This test verifies the keeper
 * observes and logs that outcome correctly, and that the wallet would
 * indeed be picked up again (since the DB layer's getDueVaults filter
 * only excludes isRecovered / isAbandoned / isCancelled — none of which
 * are true after a failed-but-retriable recovery attempt).
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
import { createMockPublicClient, createMockWalletClient, createMockDb } from "../helpers/mocks.js";
import { dueVault, WALLET_B, BACKUP_B, ONE_ETH } from "../fixtures/vaults.js";
import { failedLog, eventLogsByName } from "../fixtures/event-logs.js";
import { createReceipt, TX_HASH_1 } from "../fixtures/receipts.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);
const mockParseEventLogs = vi.mocked(parseEventLogs);

// Wallet with a backup address that rejects ETH transfers
const vaultWithBadBackup = { ...dueVault, id: WALLET_B, backupAddress: BACKUP_B };

describe("integration: failed recovery is logged and remains retriable", () => {
  let db: ReturnType<typeof createMockDb>;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    db = createMockDb();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();

    mockGetDueVaults.mockResolvedValue([vaultWithBadBackup]);
    publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);
    walletClient.writeContract.mockResolvedValue(TX_HASH_1);
    publicClient.waitForTransactionReceipt.mockResolvedValue(
      createReceipt({ logs: [{ fake: "log" }] }),
    );
    // Only RecoveryFailed fires — the transfer to BACKUP_B reverted onchain
    mockParseEventLogs.mockImplementation(({ eventName }: any): any =>
      eventName === "RecoveryFailed" ? [failedLog] : [],
    );
  });

  it("the vault is still confirmed due and submitted for recovery", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(dueWallets).toEqual([WALLET_B]);
  });

  it("logs RecoveryFailed via logger.warn with wallet, backup address, and amount", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.warn).toHaveBeenCalledWith(
      "Recovery failed — will retry next cycle",
      { wallet: WALLET_B, backupAddress: BACKUP_B, amount: ONE_ETH.toString() },
    );
  });

  it("does not log RecoveryExecuted or RecoveryAbandoned for the same wallet", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).not.toHaveBeenCalledWith("Recovery executed", expect.anything());
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Recovery abandoned — MAX_RECOVERY_ATTEMPTS exhausted",
      expect.anything(),
    );
  });

  it("batch summary reflects failed: 1, recovered: 0, abandoned: 0", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).toHaveBeenCalledWith(
      "Executor: batch confirmed",
      expect.objectContaining({ recovered: 0, failed: 1, abandoned: 0 }),
    );
  });

  it("the wallet surfaces again on a subsequent cycle (DB still reports it as due)", async () => {
    // Cycle 1
    const cycle1 = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, cycle1);

    // Contract state was restored on failure — getDueVaults would still
    // return this vault since isRecovered/isAbandoned/isCancelled remain
    // false. We simulate that unchanged DB state for cycle 2.
    mockGetDueVaults.mockResolvedValue([vaultWithBadBackup]);

    const cycle2 = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, cycle2); // ← this line was missing

    expect(cycle2).toEqual([WALLET_B]);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
  });
});