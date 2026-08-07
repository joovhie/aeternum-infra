/**
 * test/fixtures/env.ts
 *
 * Environment variable fixtures for the keeper test suite.
 *
 * Three categories:
 *   1. validProcessEnv   — complete process.env-like object (all strings)
 *                          used when testing the zod schema in index.test.ts
 *   2. mockSharedEnv     — the typed, already-validated object that
 *                          @aeternum/config exports as `env`. Use this
 *                          when vi.mock-ing @aeternum/config.
 *   3. invalidEnvCases   — named variants for testing validation failures
 *   4. envWithOverrides  — valid env with optional keeper vars set
 */

// --- Shared constants ---

export const VALID_PRIVATE_KEY =
  `0x${"ab".repeat(32)}` as `0x${string}`;

export const VALID_PRIVATE_KEY_NO_PREFIX = 
  "ab".repeat(32);

export const CONTRACT_ADDRESS =
  "0x9Eb95e4b47aECCB131f20AE7af33A29832499067" as `0x${string}`;

// --- 1. Raw process.env shape (all values are strings) ---

export const validProcessEnv: Record<string, string> = {
  // Shared vars (normally validated by @aeternum/config)
  CHAIN_ID:               "11155111",
  RPC_URL:                "https://sepolia.infura.io/v3/ef346855208f4cd486215b8a53a5ecf0",
  CONTRACT_ADDRESS:       CONTRACT_ADDRESS,
  CONTRACT_DEPLOY_BLOCK:  "11140604",
  DATABASE_URL:           "postgresql://user:password@localhost:5432/aeternum",
  // Keeper-specific
  KEEPER_PRIVATE_KEY:     VALID_PRIVATE_KEY,
};

export const validProcessEnvNoPrefix: Record<string, string> = {
  ...validProcessEnv,
  KEEPER_PRIVATE_KEY: VALID_PRIVATE_KEY_NO_PREFIX,
};

// --- 2. Typed env object exported by @aeternum/config ---

export const mockSharedEnv = {
  CHAIN_ID:              11155111,
  RPC_URL:               "https://sepolia.infura.io/v3/ef346855208f4cd486215b8a53a5ecf0",
  CONTRACT_ADDRESS:      CONTRACT_ADDRESS,
  CONTRACT_DEPLOY_BLOCK: 11140604,
  DATABASE_URL:          "postgresql://user:password@localhost:5432/aeternum",
} as const;

// --- 3. Invalid env cases — for validation failure tests ---

export const invalidEnvCases = {
  /** KEEPER_PRIVATE_KEY is entirely absent */
  missingPrivateKey: {
    ...validProcessEnv,
    KEEPER_PRIVATE_KEY: undefined,
  },

  /** Private key with 0x prefix but only 16 bytes */
  tooShortWithPrefix: {
    ...validProcessEnv,
    KEEPER_PRIVATE_KEY: `0x${"ab".repeat(16)}`,
  },

  /** Private key without prefix and only 16 bytes */
  tooShortNoPrefix: {
    ...validProcessEnv,
    KEEPER_PRIVATE_KEY: "ab".repeat(16),
  },

  /** Correct length but non-hex characters */
  nonHexChars: {
    ...validProcessEnv,
    KEEPER_PRIVATE_KEY: `0x${"zz".repeat(32)}`,
  },

  /** Empty string */
  emptyString: {
    ...validProcessEnv,
    KEEPER_PRIVATE_KEY: "",
  },
} as const;

// --- 4. Valid env with optional overrides explicitly set ---

export const envWithOverrides: Record<string, string> = {
  ...validProcessEnv,
  KEEPER_POLL_INTERVAL_MS: "30000",
  KEEPER_BATCH_SIZE:       "500",
};