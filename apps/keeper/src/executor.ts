/**
 * src/executor.ts
 *
 * Submits triggerRecovery for a list of confirmed due wallets using
 * Multicall3's aggregate3 with allowFailure: true.
 *
 * WHY MULTICALL3:
 *   Batching multiple triggerRecovery calls into a single transaction
 *   saves the 21,000 gas base cost per tx. More importantly, allowFailure:
 *   true means a single vault's ETH transfer failure (e.g. a backup address
 *   that rejects ETH) does not revert the entire batch. Each wallet is
 *   handled independently — the same isolation guarantee the contract
 *   provides through _executeRecovery's silent-return design.
 *
 * MAX_CALLS_PER_TX:
 *   Capped at 120 wallets per transaction. This is a hard safety ceiling,
 *   independent of KEEPER_BATCH_SIZE (which only controls how many
 *   candidates are pulled from the DB per scan — see scanner.ts). Raising
 *   KEEPER_BATCH_SIZE for DB scan efficiency must never silently grow the
 *   number of calls submitted in a single transaction.
 *
 *   Derivation: 120 × 90,988 gas (measured triggerRecovery max, full
 *   execution path) × 1.3 gas buffer ≈ 14,194,128 gas — roughly 23.7% of
 *   the current 60M mainnet/Sepolia block gas limit. Comfortable headroom
 *   even under network congestion. If the wallets confirmed due in a
 *   cycle exceed this cap, they are split into multiple sequential
 *   transactions.
 *
 * GAS ESTIMATION:
 *   Before submission, gas is estimated per-batch via estimateContractGas
 *   and inflated by GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR (30%).
 *   This mitigates a specific failure mode observed during integration
 *   testing: eth_estimateGas's binary search does not always account
 *   precisely enough for EIP-150's 63/64ths gas-forwarding rule across
 *   nested calls (Multicall3 → AeternumVault → backup address), which
 *   caused individual sub-calls to run out of gas and revert on-chain
 *   even though the parent aggregate3 transaction succeeded. The buffer
 *   is an empirical safety margin, not a formal guarantee — retune
 *   GAS_BUFFER_NUMERATOR if contract logic changes in a way that shifts
 *   per-call gas cost.
 *
 *   MAX_GAS_PER_TX is an independent hard ceiling applied after
 *   buffering, as defense in depth against an anomalous estimate (RPC
 *   glitch, a backup address with a deliberately expensive receive())
 *   being submitted unchecked.
 *
 * NONCE SAFETY:
 *   Batches are submitted sequentially — each awaits a receipt before
 *   the next is submitted. This keeps nonce ordering simple and avoids
 *   replacement-transaction edge cases.
 */

import { encodeFunctionData, parseEventLogs } from "viem";
import {
  AETERNUM_VAULT_ABI,
  MULTICALL3_ABI,
  MULTICALL3_ADDRESS,
  type ViemPublicClient,
  type ViemWalletClient,
} from "@aeternum/blockchain";
import { logger } from "./logger.js";
import type { Address } from "./scanner.js";

// Hard ceiling on calls submitted in a single transaction. Decoupled from
// KEEPER_BATCH_SIZE (DB scan limit) by design — see file header.
const MAX_CALLS_PER_TX = 120;

// Gas estimate buffer: estimatedGas × 130 / 100 = 30% headroom.
const GAS_BUFFER_NUMERATOR = 130n;
const GAS_BUFFER_DENOMINATOR = 100n;

// Independent safety ceiling applied after buffering. Expected buffered
// max at MAX_CALLS_PER_TX is ~14.2M gas — this leaves headroom for
// estimation variance while still catching a truly anomalous estimate,
// comfortably under the 60M block gas limit.
const MAX_GAS_PER_TX = 20_000_000n;

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Executes recovery for a confirmed list of due wallet addresses.
 *
 * Wallets are split into batches of at most MAX_CALLS_PER_TX and
 * submitted via Multicall3.aggregate3, with gas estimated and buffered
 * per batch. RecoveryExecuted, RecoveryFailed, and RecoveryAbandoned
 * events are parsed from each receipt and logged individually so the
 * outcome of every wallet is observable.
 *
 * @param walletClient    Signing client for transaction submission.
 * @param publicClient    Read client for gas estimation and receipt retrieval.
 * @param contractAddress AeternumVault contract address.
 * @param wallets         Onchain-confirmed due wallet addresses from scanner.
 */
export async function execute(
  walletClient: ViemWalletClient,
  publicClient: ViemPublicClient,
  contractAddress: Address,
  wallets: Address[],
): Promise<void> {
  if (wallets.length === 0) return;

  const batches = chunk(wallets, MAX_CALLS_PER_TX);

  logger.info("Executor: beginning execution", {
    totalWallets: wallets.length,
    totalBatches: batches.length,
  });

  for (const [batchIndex, batch] of batches.entries()) {
    const batchNum = batchIndex + 1;

    logger.info("Executor: submitting batch", {
      batch: batchNum,
      of: batches.length,
      wallets: batch.length,
    });

    const calls = batch.map((wallet) => ({
      target: contractAddress,
      allowFailure: true as const,
      callData: encodeFunctionData({
        abi: AETERNUM_VAULT_ABI,
        functionName: "triggerRecovery",
        args: [wallet],
      }),
    }));

    try {
      // 1. Estimate gas for the full batch. Simulated from the keeper's
      //    own account since gas cost can be sender-context-dependent.
      const estimatedGas = await publicClient.estimateContractGas({
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [calls],
        account: walletClient.account,
      });

      // 2. Apply the 30% buffer, then clamp to the hard ceiling.
      const bufferedGas =
        (estimatedGas * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      const gasWithBuffer =
        bufferedGas > MAX_GAS_PER_TX ? MAX_GAS_PER_TX : bufferedGas;

      logger.debug("Executor: gas estimated", {
        batch: batchNum,
        estimatedGas: estimatedGas.toString(),
        gasWithBuffer: gasWithBuffer.toString(),
      });

      // 3. Submit with the buffered, capped gas limit.
      const hash = await walletClient.writeContract({
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [calls],
        gas: gasWithBuffer,
      });

      logger.info("Executor: transaction submitted", { hash, batch: batchNum });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // RecoveryExecuted — ETH transfer to backup address succeeded.
      const executedLogs = parseEventLogs({
        abi: AETERNUM_VAULT_ABI,
        eventName: "RecoveryExecuted",
        logs: receipt.logs,
      });

      // RecoveryFailed — backup address rejected ETH. State restored,
      // failedRecoveryAttempts incremented. Keeper will retry next cycle.
      const failedLogs = parseEventLogs({
        abi: AETERNUM_VAULT_ABI,
        eventName: "RecoveryFailed",
        logs: receipt.logs,
      });

      // RecoveryAbandoned — MAX_RECOVERY_ATTEMPTS exhausted.
      // Balance preserved in vault; re-registration with new backup required.
      const abandonedLogs = parseEventLogs({
        abi: AETERNUM_VAULT_ABI,
        eventName: "RecoveryAbandoned",
        logs: receipt.logs,
      });

      logger.info("Executor: batch confirmed", {
        hash,
        block: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        recovered: executedLogs.length,
        failed: failedLogs.length,
        abandoned: abandonedLogs.length,
        submitted: batch.length,
      });

      for (const log of executedLogs) {
        logger.info("Recovery executed", {
          wallet: log.args.wallet,
          backupAddress: log.args.backupAddress,
          amount: log.args.amount?.toString(),
        });
      }

      for (const log of failedLogs) {
        logger.warn("Recovery failed — will retry next cycle", {
          wallet: log.args.wallet,
          backupAddress: log.args.backupAddress,
          amount: log.args.amount?.toString(),
        });
      }

      for (const log of abandonedLogs) {
        logger.warn("Recovery abandoned — MAX_RECOVERY_ATTEMPTS exhausted", {
          wallet: log.args.wallet,
          backupAddress: log.args.backupAddress,
          balance: log.args.balance?.toString(),
        });
      }
    } catch (err) {
      // Log and continue — a failed batch must not abort subsequent batches.
      logger.error("Executor: batch submission failed", {
        batch: batchNum,
        wallets: batch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}