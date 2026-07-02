import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xcalldata"),
  parseEventLogs: vi.fn().mockReturnValue([]),
}));

vi.mock("@aeternum/blockchain", () => ({
  AETERNUM_VAULT_ABI: [],
  MULTICALL3_ABI: [],
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  },
}));

import { encodeFunctionData, parseEventLogs } from "viem";
import { MULTICALL3_ADDRESS } from "@aeternum/blockchain";
import { execute } from "../../src/executor.js";
import { logger } from "../../src/logger.js";
import { createMockPublicClient, createMockWalletClient, makeAddresses } from "../helpers/mocks.js";
import { createReceipt, TX_HASH_1, TX_HASH_2 } from "../fixtures/receipts.js";
import { executedLog, failedLog, abandonedLog, eventLogsByName } from "../fixtures/event-logs.js";
import { CONTRACT_ADDRESS } from "../fixtures/env.js";
import { WALLET_A } from "../fixtures/vaults.js";

const mockEncodeFunctionData = vi.mocked(encodeFunctionData);
const mockParseEventLogs    = vi.mocked(parseEventLogs);

describe("executor.execute", () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    mockParseEventLogs.mockReturnValue([]);
  });

  // --- Empty input ---

  it("returns immediately without submitting anything when wallets is empty", async () => {
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, []);

    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  // --- Single batch ---

  describe("single batch (<= 120 wallets)", () => {
    it("submits exactly one transaction for 100 wallets", async () => {
      walletClient.writeContract.mockResolvedValue(TX_HASH_1);
      publicClient.waitForTransactionReceipt.mockResolvedValue(createReceipt());

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(100));

      expect(walletClient.writeContract).toHaveBeenCalledOnce();
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledOnce();
    });

    it("calls encodeFunctionData once per wallet with triggerRecovery and the wallet arg", async () => {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(mockEncodeFunctionData).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "triggerRecovery",
          args: [WALLET_A],
        }),
      );
    });

    it("submits to MULTICALL3_ADDRESS using aggregate3", async () => {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      const callArgs = walletClient.writeContract.mock.calls[0][0];
      expect(callArgs.address).toBe(MULTICALL3_ADDRESS);
      expect(callArgs.functionName).toBe("aggregate3");
    });

    it("builds each call entry with target, allowFailure: true, and encoded callData", async () => {
      mockEncodeFunctionData.mockReturnValue("0xdeadbeef");

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      const callArgs = walletClient.writeContract.mock.calls[0][0];
      const [calls] = callArgs.args;
      expect(calls).toEqual([
        { target: CONTRACT_ADDRESS, allowFailure: true, callData: "0xdeadbeef" },
      ]);
    });

    it("calls waitForTransactionReceipt with the hash returned by writeContract", async () => {
      walletClient.writeContract.mockResolvedValue(TX_HASH_1);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH_1 });
    });

    it("calls estimateContractGas with the correct aggregate3 multicall arguments", async () => {
      publicClient.estimateContractGas.mockResolvedValue(150_000n);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(publicClient.estimateContractGas).toHaveBeenCalledWith(
        expect.objectContaining({
          address: MULTICALL3_ADDRESS,
          functionName: "aggregate3",
        })
      );
    });

    it("applies the 30% buffer to the estimated gas before writeContract", async () => {
      publicClient.estimateContractGas.mockResolvedValue(100_000n);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      const callArgs = walletClient.writeContract.mock.calls[0][0];
      // 100_000n * 130n / 100n = 130_000n
      expect(callArgs.gas).toBe(130_000n);
    });

    it("clamps the buffered gas to MAX_GAS_PER_TX when the estimate is anomalously high", async () => {
      // 100_000_000n * 1.3 = 130_000_000n, which exceeds the 20_000_000n ceiling
      publicClient.estimateContractGas.mockResolvedValue(100_000_000n);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      const callArgs = walletClient.writeContract.mock.calls[0][0];
      expect(callArgs.gas).toBe(20_000_000n);
    });
  });

  // --- Batch splitting ---

  describe("batch splitting (> 120 wallets)", () => {
    it("splits 130 wallets into batches of 120 and 10", async () => {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(130));

      expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
      const firstBatch  = walletClient.writeContract.mock.calls[0][0].args[0];
      const secondBatch = walletClient.writeContract.mock.calls[1][0].args[0];
      expect(firstBatch).toHaveLength(120);
      expect(secondBatch).toHaveLength(10);
    });

    it("splits exactly 240 wallets into two full batches of 120", async () => {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(240));

      expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
      const firstBatch  = walletClient.writeContract.mock.calls[0][0].args[0];
      const secondBatch = walletClient.writeContract.mock.calls[1][0].args[0];
      expect(firstBatch).toHaveLength(120);
      expect(secondBatch).toHaveLength(120);
    });

    it("does not split exactly 120 wallets into multiple batches", async () => {
      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(120));

      expect(walletClient.writeContract).toHaveBeenCalledOnce();
    });

    it("submits batches sequentially — second batch starts only after first receipt resolves", async () => {
      const callOrder: string[] = [];

      walletClient.writeContract.mockImplementation(async () => {
        callOrder.push("write");
        return TX_HASH_1;
      });
      publicClient.waitForTransactionReceipt.mockImplementation(async () => {
        callOrder.push("receipt");
        return createReceipt();
      });

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(130));

      expect(callOrder).toEqual(["write", "receipt", "write", "receipt"]);
    });
  });

  // --- Event log parsing and per-outcome logging ---

  describe("event outcome logging", () => {
    it("parses RecoveryExecuted, RecoveryFailed, and RecoveryAbandoned from receipt.logs", async () => {
      const receipt = createReceipt({ logs: [{ fake: "log" }] });
      publicClient.waitForTransactionReceipt.mockResolvedValue(receipt);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(mockParseEventLogs).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "RecoveryExecuted", logs: receipt.logs }),
      );
      expect(mockParseEventLogs).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "RecoveryFailed", logs: receipt.logs }),
      );
      expect(mockParseEventLogs).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "RecoveryAbandoned", logs: receipt.logs }),
      );
    });

    it("logs each RecoveryExecuted event individually via logger.info", async () => {
      mockParseEventLogs.mockImplementation(({ eventName }: any) =>
        eventLogsByName(eventName) as any
      );

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.info).toHaveBeenCalledWith(
        "Recovery executed",
        expect.objectContaining({
          wallet: executedLog.args.wallet,
          backupAddress: executedLog.args.backupAddress,
          amount: executedLog.args.amount.toString(),
        }),
      );
    });

    it("logs each RecoveryFailed event individually via logger.warn", async () => {
      mockParseEventLogs.mockImplementation(({ eventName }: any) =>
        eventLogsByName(eventName) as any
      );

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.warn).toHaveBeenCalledWith(
        "Recovery failed — will retry next cycle",
        expect.objectContaining({
          wallet: failedLog.args.wallet,
          backupAddress: failedLog.args.backupAddress,
          amount: failedLog.args.amount.toString(),
        }),
      );
    });

    it("logs each RecoveryAbandoned event individually via logger.warn with balance field", async () => {
      mockParseEventLogs.mockImplementation(({ eventName }: any) =>
        eventLogsByName(eventName) as any
      );

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.warn).toHaveBeenCalledWith(
        "Recovery abandoned — MAX_RECOVERY_ATTEMPTS exhausted",
        expect.objectContaining({
          wallet: abandonedLog.args.wallet,
          backupAddress: abandonedLog.args.backupAddress,
          balance: abandonedLog.args.balance.toString(),
        }),
      );
    });

    it("logs a batch summary with recovered/failed/abandoned/submitted counts", async () => {
      mockParseEventLogs.mockImplementation(({ eventName }: any) =>
        eventLogsByName(eventName) as any
      );
      const receipt = createReceipt({ blockNumber: 55n, gasUsed: 91_000n });
      publicClient.waitForTransactionReceipt.mockResolvedValue(receipt);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.info).toHaveBeenCalledWith(
        "Executor: batch confirmed",
        expect.objectContaining({
          block: "55",
          gasUsed: "91000",
          recovered: 1,
          failed: 1,
          abandoned: 1,
          submitted: 1,
        }),
      );
    });
  });

  // --- Failure isolation ---

  describe("failure isolation between batches", () => {
    it("logs an error and continues to the next batch when writeContract throws", async () => {
      walletClient.writeContract
        .mockRejectedValueOnce(new Error("nonce too low"))
        .mockResolvedValueOnce(TX_HASH_2);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(130));

      expect(logger.error).toHaveBeenCalledWith(
        "Executor: batch submission failed",
        expect.objectContaining({ batch: 1, error: "nonce too low" }),
      );
      // Second batch still attempted despite first batch's failure
      expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    });

    it("logs an error and continues to the next batch if estimateContractGas throws", async () => {
      // Simulate gas estimation failing on the first batch, but succeeding on the second
      publicClient.estimateContractGas
        .mockRejectedValueOnce(new Error("gas estimation reverted: execution reverted"))
        .mockResolvedValueOnce(200_000n);

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(130));

      // Verify the error was logged for the first batch
      expect(logger.error).toHaveBeenCalledWith(
        "Executor: batch submission failed",
        expect.objectContaining({
          batch: 1,
          error: "gas estimation reverted: execution reverted"
        }),
      );

      // Verify that writeContract was only called once (for the successful second batch)
      expect(walletClient.writeContract).toHaveBeenCalledOnce();
    });

    it("logs an error and does not throw when waitForTransactionReceipt throws", async () => {
      publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("dropped"));

      await expect(
        execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]),
      ).resolves.not.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        "Executor: batch submission failed",
        expect.objectContaining({ error: "dropped" }),
      );
    });

    it("includes the failed batch's wallet list in the error log", async () => {
      walletClient.writeContract.mockRejectedValue(new Error("reverted"));

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.error).toHaveBeenCalledWith(
        "Executor: batch submission failed",
        expect.objectContaining({ wallets: [WALLET_A] }),
      );
    });

    it("stringifies a non-Error value thrown during batch submission", async () => {
      walletClient.writeContract.mockRejectedValue("nonce manager rejected request");

      await execute(walletClient, publicClient, CONTRACT_ADDRESS, [WALLET_A]);

      expect(logger.error).toHaveBeenCalledWith(
        "Executor: batch submission failed",
        expect.objectContaining({ error: "nonce manager rejected request" }),
      );
    });
  });

  // --- Top-level progress logging ---

  it("logs total wallet and batch counts at the start of execution", async () => {
    await execute(walletClient, publicClient, CONTRACT_ADDRESS, makeAddresses(130));

    expect(logger.info).toHaveBeenCalledWith(
      "Executor: beginning execution",
      { totalWallets: 130, totalBatches: 2 },
    );
  });
});