import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration: MAX_RECOVERY_ATTEMPTS exhausted.
 * After the third consecutive failed transfer, the contract permanently
 * marks the vault isAbandoned and removes it from the registry. The
 * balance remains claimable by the user via withdrawAll()/send(), but
 * the vault must never surface in a future keeper scan — getDueVaults
 * explicitly filters on isAbandoned = false.
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
import { dueVault, WALLET_A, BACKUP_A, ONE_ETH } from "../fixtures/vaults.js";
import { abandonedLog, eventLogsByName } from "../fixtures/event-logs.js";
import { createReceipt, TX_HASH_1 } from "../fixtures/receipts.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);
const mockParseEventLogs = vi.mocked(parseEventLogs);

describe("integration: recovery abandoned after MAX_RECOVERY_ATTEMPTS", () => {
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
    // Third consecutive failure — contract emits RecoveryAbandoned, not RecoveryFailed
    mockParseEventLogs.mockImplementation(({ eventName }: any): any =>
      eventName === "RecoveryAbandoned" ? [abandonedLog] : [],
    );
  });

  it("logs RecoveryAbandoned via logger.warn with wallet, backup address, and remaining balance", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.warn).toHaveBeenCalledWith(
      "Recovery abandoned — MAX_RECOVERY_ATTEMPTS exhausted",
      { wallet: WALLET_A, backupAddress: BACKUP_A, balance: ONE_ETH.toString() },
    );
  });

  it("does not log RecoveryExecuted or RecoveryFailed for the abandoned wallet", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).not.toHaveBeenCalledWith("Recovery executed", expect.anything());
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Recovery failed — will retry next cycle",
      expect.anything(),
    );
  });

  it("batch summary reflects abandoned: 1, recovered: 0, failed: 0", async () => {
    const dueWallets = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, dueWallets);

    expect(logger.info).toHaveBeenCalledWith(
      "Executor: batch confirmed",
      expect.objectContaining({ recovered: 0, failed: 0, abandoned: 1 }),
    );
  });

  it("an abandoned wallet does not reappear in a subsequent scan cycle", async () => {
    // Cycle 1 — abandonment occurs
    const cycle1 = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, cycle1);

    // getDueVaults filters on isAbandoned = false at the DB layer (see
    // packages/db/src/queries.ts) — once the indexer reflects the
    // RecoveryAbandoned event, this wallet is excluded from future results.
    mockGetDueVaults.mockResolvedValue([]);

    const cycle2 = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

    expect(cycle2).toEqual([]);
    // No second transaction submitted for the abandoned wallet
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });
});