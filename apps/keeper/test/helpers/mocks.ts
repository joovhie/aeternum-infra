/**
 * test/helpers/mocks.ts
 *
 * Factory functions that create typed vi.fn() mocks for every external
 * client the keeper uses. Each factory returns a fresh set of mock
 * functions on every call — tests never share mock state.
 *
 * USAGE PATTERN:
 * const publicClient = createMockPublicClient();
 * publicClient.multicall.mockResolvedValue([...]);
 *
 * The interfaces extend the real viem/drizzle types so mocks can be
 * passed directly to scan(), execute(), etc. without any casting at
 * the call site.
 */

import { vi, type MockInstance } from "vitest";
import type { ViemPublicClient, ViemWalletClient } from "@aeternum/blockchain";
import type { DbClient } from "@aeternum/db";
import { TX_HASH_1 } from "../fixtures/receipts.js";

// --- Address / hash generators ---

/**
 * Generates a deterministic Ethereum address from a number.
 * makeAddress(1) → 0x0000...0001, makeAddress(255) → 0x0000...00ff
 */
export const makeAddress = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

/**
 * Generates a deterministic 32-byte transaction hash from a number.
 * makeTxHash(1) → 0x0000...0001
 */
export const makeTxHash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

/**
 * Generates an array of n deterministic addresses starting from index 1.
 * Useful for populating large wallet lists in batch execution tests.
 *
 * @example makeAddresses(25) → [`0x0000...0001`, ..., `0x0000...0019`]
 */
export const makeAddresses = (n: number): `0x${string}`[] =>
  Array.from({ length: n }, (_, i) => makeAddress(i + 1));

// --- Client interfaces with accessible mock methods ---
// We use Omit to strip the original methods, then intersect (&) the original 
// Viem signature with MockInstance. This satisfies both Viem's strict arguments 
// and Vitest's mocking utilities (like .mockResolvedValue).

export type MockPublicClient = Omit<
  ViemPublicClient, 
  "multicall" | "waitForTransactionReceipt" | "estimateContractGas"
> & {
  multicall: ViemPublicClient["multicall"] & MockInstance;
  waitForTransactionReceipt: ViemPublicClient["waitForTransactionReceipt"] & MockInstance;
  estimateContractGas: ViemPublicClient["estimateContractGas"] & MockInstance;
};

export type MockWalletClient = Omit<ViemWalletClient, "writeContract"> & {
  writeContract: ViemWalletClient["writeContract"] & MockInstance;
};

// --- Factories ---

/**
 * Creates a mock viem public client.
 *
 * Defaults:
 * multicall            → resolves to [] (no due vaults)
 * estimateContractGas  → resolves to a simulated baseline gas value (e.g., 70_000_000n / 100n)
 * waitForTransactionReceipt → resolves to a minimal success receipt
 *
 * Override per-test:
 * publicClient.multicall.mockResolvedValue([{ status: "success", result: true }]);
 */
export function createMockPublicClient(): MockPublicClient {
  return {
    multicall: vi.fn().mockResolvedValue([]),
    estimateContractGas: vi.fn().mockResolvedValue(70_000_000n / 100n), // default: 700,000 gas — override per test
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      blockNumber:     100n,
      gasUsed:         91_000n,
      logs:            [],
      transactionHash: TX_HASH_1,
      status:          "success" as const,
    }),
  } as unknown as MockPublicClient;
}

/**
 * Creates a mock viem wallet client.
 *
 * Default:
 * writeContract → resolves to TX_HASH_1
 *
 * Override per-test:
 * walletClient.writeContract.mockRejectedValue(new Error("out of gas"));
 */
export function createMockWalletClient(): MockWalletClient {
  return {
    writeContract: vi.fn().mockResolvedValue(TX_HASH_1),
  } as unknown as MockWalletClient;
}

/**
 * Creates a mock Drizzle DB client.
 *
 * The keeper only ever passes `db` to getDueVaults(), which is mocked
 * at the module level in every test file. The DB client itself needs no
 * real methods — it just has to satisfy the DbClient type so TypeScript
 * is happy passing it to scan().
 */
export function createMockDb(): DbClient {
  return {} as DbClient;
}