/**
 * test/fixtures/vaults.ts
 *
 * Vault record fixtures covering every lifecycle state the keeper
 * encounters. Timestamps are computed relative to Date.now() at
 * import time so fixtures never go stale as time passes.
 *
 * Address constants are exported separately so integration tests can
 * use them to match against log args without re-deriving them.
 */

import type { Vault } from "@aeternum/db";

// --- Timing constants ---

const NOW      = BigInt(Math.floor(Date.now() / 1000));
const ONE_YEAR = BigInt(365 * 24 * 60 * 60); // 31_536_000n
const ONE_DAY  = BigInt(24 * 60 * 60);        //     86_400n

// --- Address constants ---

export const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
export const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
export const WALLET_C = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

export const BACKUP_A = "0x000000000000000000000000000000000000000a" as `0x${string}`;
export const BACKUP_B = "0x000000000000000000000000000000000000000b" as `0x${string}`;
export const BACKUP_C = "0x000000000000000000000000000000000000000c" as `0x${string}`;

export const ONE_ETH = 1_000_000_000_000_000_000n;

// --- Base template ---

const BASE: Vault = {
  id:                    `11155111-${WALLET_A}`,
  chainId:               11155111,
  wallet:                WALLET_A,
  backupAddress:         BACKUP_A,
  inactivityPeriod:      ONE_YEAR,
  lastActivityTimestamp: NOW - ONE_YEAR - ONE_DAY, // 1 year + 1 day ago
  isRecovered:           false,
  isAbandoned:           false,
  isCancelled:           false,
  createdAtBlock:        11_140_604n,
};

// --- Individual lifecycle fixtures ---

/** Deadline has passed — eligible for triggerRecovery */
export const dueVault: Vault = { ...BASE };

/** Halfway through inactivity period — not yet eligible */
export const activeVault: Vault = {
  ...BASE,
  id:                    `11155111-${WALLET_B}`,
  wallet:                WALLET_B,
  backupAddress:         BACKUP_B,
  lastActivityTimestamp: NOW - ONE_YEAR / 2n,
};

/** Recovery already executed — isRecovered: true */
export const recoveredVault: Vault = {
  ...BASE,
  isRecovered: true,
};

/**
 * Backup address exhausted MAX_RECOVERY_ATTEMPTS.
 * Balance is preserved; re-registration with a new backup is required.
 */
export const abandonedVault: Vault = {
  ...BASE,
  isAbandoned: true,
};

/** User called cancelRecovery() */
export const cancelledVault: Vault = {
  ...BASE,
  isCancelled: true,
};

/** Registered but never funded — balance would be 0 in contract */
export const zeroBalanceVault: Vault = {
  ...BASE,
  id:           WALLET_C,
  backupAddress: BACKUP_C,
};

// --- Multi-vault arrays ---

/** Three wallets all past their deadline */
export const threeDueVaults: Vault[] = [
  dueVault,
  { ...dueVault, id: `11155111-${WALLET_B}`, wallet: WALLET_B, backupAddress: BACKUP_B },
  { ...dueVault, id: `11155111-${WALLET_C}`, wallet: WALLET_C, backupAddress: BACKUP_C },
];

/** Mix of one due and one active — scanner should return only the due one */
export const mixedVaults: Vault[] = [
  dueVault,
  activeVault,
];