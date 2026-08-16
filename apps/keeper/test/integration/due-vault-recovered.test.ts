import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration: happy path.
 * Exercises the real scan() and execute() together — the same composition
 * runCycle() performs in src/index.ts — to verify a due vault flows all
 * the way from DB candidate to a confirmed RecoveryExecuted log.
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
import { encodeFunctionData, parseEventLogs } from "viem";
import { scan } from "../../src/scanner.js";
import { execute } from "../../src/executor.js";
import { logger } from "../../src/logger.js";
import { createMockPublicClient, createMockWalletClient, createMockDb } from "../helpers/mocks.js";
import { dueVault, WALLET_A, BACKUP_A, ONE_ETH } from "../fixtures/vaults.js";
import { executedLog, eventLogsByName } from "../fixtures/event-logs.js";
import { createReceipt, TX_HASH_1 } from "../fixtures/receipts.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);
const mockParseEventLogs = vi.mocked(parseEventLogs);

describe("integration: due vault is recovered end-to-end", () => {
  let db: ReturnType<typeof createMockDb>;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    db = createMockDb();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();

    mockGetDueVaults.mockResolvedValue([dueVault]);
    publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);
    walletClient.writeContract.mockResolvedValue(TX_HASH_1);
    publicClient.waitForTransactionReceipt.mockResolvedValue(
      createReceipt({ logs: [{ fake: "log" }] }),
    );
    mockParseEventLogs.mockImplementation(({ eventName }: any): any =>
      eventName === "RecoveryExecuted" ? eventLogsByName(eventName) : [],
    );
  });

  it("scan confirms the wallet as due after DB pre-filter and onchain validation", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(dueWallets).toEqual([WALLET_A]);
  });

  it("execute submits triggerRecovery via Multicall3 for the confirmed wallet", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(encodeFunctionData).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "triggerRecovery", args: [WALLET_A] }),
    );
  });

  it("logs RecoveryExecuted with the correct wallet, backup address, and amount", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).toHaveBeenCalledWith(
      "Recovery executed",
      { wallet: WALLET_A, backupAddress: BACKUP_A, amount: ONE_ETH.toString() },
    );
    // Sanity check that the fixture itself matches the vault under test
    expect(executedLog.args.wallet).toBe(WALLET_A);
  });

  it("full pipeline: zero due wallets means execute is never reached", async () => {
    mockGetDueVaults.mockResolvedValueOnce([]);

    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    if (dueWallets.length > 0) {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);
    }

    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("logs a batch confirmation summary with recovered: 1", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).toHaveBeenCalledWith(
      "Executor: batch confirmed",
      expect.objectContaining({ recovered: 1, failed: 0, abandoned: 0, submitted: 1 }),
    );
  });
});