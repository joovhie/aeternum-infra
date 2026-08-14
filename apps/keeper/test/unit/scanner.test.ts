import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aeternum/db", () => ({
  getDueVaults: vi.fn(),
}));

vi.mock("@aeternum/blockchain", () => ({
  AETERNUM_VAULT_ABI: [],
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  },
}));

import { getDueVaults } from "@aeternum/db";
import { scan } from "../../src/scanner.js";
import { logger } from "../../src/logger.js";
import { createMockPublicClient, createMockDb } from "../helpers/mocks.js";
import { dueVault, activeVault, WALLET_A, WALLET_B, WALLET_C } from "../fixtures/vaults.js";
import { CONTRACT_ADDRESS, mockSharedEnv } from "../fixtures/env.js";

const mockGetDueVaults = vi.mocked(getDueVaults);

describe("scanner.scan", () => {
  let db: ReturnType<typeof createMockDb>;
  let publicClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    db = createMockDb();
    publicClient = createMockPublicClient();
  });

  // --- DB layer ---

  describe("DB pre-filter (layer 1)", () => {
    it("returns [] without calling multicall when DB returns no candidates", async () => {
      mockGetDueVaults.mockResolvedValue([]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
      expect(publicClient.multicall).not.toHaveBeenCalled();
    });

    it("passes dbScanLimit through to getDueVaults", async () => {
      mockGetDueVaults.mockResolvedValue([]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 250);

      expect(mockGetDueVaults).toHaveBeenCalledWith(db, mockSharedEnv.CHAIN_ID, 250);
    });

    it("returns [] and logs an error when the DB query throws", async () => {
      mockGetDueVaults.mockRejectedValue(new Error("connection refused"));

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "Scanner: DB query failed, skipping cycle",
        expect.objectContaining({ error: "connection refused" }),
      );
      expect(publicClient.multicall).not.toHaveBeenCalled();
    });

    it("stringifies a non-Error value thrown by the DB query", async () => {
      mockGetDueVaults.mockRejectedValue("connection string malformed");

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "Scanner: DB query failed, skipping cycle",
        { error: "connection string malformed" },
      );
    });

    it("logs candidate count when DB returns rows", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(logger.info).toHaveBeenCalledWith(
        "Scanner: DB candidates found",
        { count: 1 },
      );
    });

    it("maps row.id to the candidates array passed to multicall", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]); // id: WALLET_A
      publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      const callArgs = publicClient.multicall.mock.calls[0][0];
      expect(callArgs.contracts[0].args).toEqual([WALLET_A]);
    });
  });

  // --- Onchain validation layer ---

  describe("onchain validation (layer 2)", () => {
    it("calls multicall once with one contract entry per candidate", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },
        { status: "success", result: false },
      ]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(publicClient.multicall).toHaveBeenCalledOnce();
      const callArgs = publicClient.multicall.mock.calls[0][0];
      expect(callArgs.contracts).toHaveLength(2);
      expect(callArgs.allowFailure).toBe(true);
    });

    it("calls isRecoveryDue with the correct contract address for every candidate", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },
        { status: "success", result: true },
      ]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      const callArgs = publicClient.multicall.mock.calls[0][0];
      for (const contract of callArgs.contracts) {
        expect(contract.address).toBe(CONTRACT_ADDRESS);
        expect(contract.functionName).toBe("isRecoveryDue");
      }
    });

    it("returns only wallets confirmed due (status success, result true)", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]); // WALLET_A, WALLET_B
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },  // WALLET_A confirmed
        { status: "success", result: false }, // WALLET_B stale — no longer due
      ]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([WALLET_A]);
    });

    it("filters out entries with status: failure regardless of result", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "failure" },
      ]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
    });

    it("logs the count of stale entries filtered out", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },
        { status: "success", result: false },
      ]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(logger.info).toHaveBeenCalledWith(
        "Scanner: stale DB entries filtered out",
        { stale: 1 },
      );
    });

    it("does not log stale-entries message when there are no stale entries", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(logger.info).not.toHaveBeenCalledWith(
        "Scanner: stale DB entries filtered out",
        expect.anything(),
      );
    });

    it("logs the final onchain-confirmed count", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);

      await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(logger.info).toHaveBeenCalledWith(
        "Scanner: onchain-confirmed due vaults",
        { count: 1 },
      );
    });

    it("returns [] and logs an error when multicall throws", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockRejectedValue(new Error("RPC timeout"));

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "Scanner: onchain validation failed, skipping cycle",
        expect.objectContaining({ error: "RPC timeout" }),
      );
    });

    it("stringifies a non-Error value thrown by multicall", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault]);
      publicClient.multicall.mockRejectedValue("RPC node returned malformed response");

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "Scanner: onchain validation failed, skipping cycle",
        { error: "RPC node returned malformed response" },
      );
    });

    it("returns all candidates when all are confirmed due", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },
        { status: "success", result: true },
      ]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([WALLET_A, WALLET_B]);
    });

    it("returns [] when none of the candidates are confirmed due", async () => {
      mockGetDueVaults.mockResolvedValue([dueVault, activeVault]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: false },
        { status: "success", result: false },
      ]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([]);
    });

    it("preserves candidate ordering in the returned array", async () => {
      mockGetDueVaults.mockResolvedValue([
        dueVault,
        { ...activeVault, id: WALLET_C },
      ]);
      publicClient.multicall.mockResolvedValue([
        { status: "success", result: true },
        { status: "success", result: true },
      ]);

      const result = await scan(db, mockSharedEnv.CHAIN_ID, publicClient, CONTRACT_ADDRESS, 1000);

      expect(result).toEqual([WALLET_A, WALLET_C]);
    });
  });
});