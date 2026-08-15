import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAddress, makeTxHash, createBareMockDb } from "../helpers/mocks.js";
import type { DbClient } from "@aeternum/db";
import type { CampaignDbClient } from "../../src/db/client.js";
import type { VaultTransaction } from "@aeternum/db";

// PHASE_WEIGHTS.mainnet is computed once, at module load, from
// campaignEnv.CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER — so unlike the dust
// threshold (read per-call), this value is effectively fixed for the
// whole file once weights.js first evaluates. 3 here, tests assume 3.
const mockEnv = vi.hoisted(() => ({
  CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER: 3,
  CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI: 1_000_000n,
  CAMPAIGN_MIN_HOLD_SECONDS: 86_400,
}));

vi.mock("../../src/env.js", () => ({ campaignEnv: mockEnv }));

vi.mock("../../src/db/queries.js", () => ({
  insertLedgerEntries: vi.fn(async (_db, entries) => entries),
}));

vi.mock("../../src/indexerReads/queries.js", () => ({
  getTransactionsByType: vi.fn(),
}));

vi.mock("../../src/scoring/antiGaming.js", () => ({
  underDailyRateLimit: vi.fn(async () => true),
  clearedMinHold: vi.fn(async () => true),
  passesFundingSourceCheck: vi.fn(async () => true),
}));

import { runSepoliaScoring, runMainnetRegistrationScoring } from "../../src/scoring/computePoints.js";
import { insertLedgerEntries } from "../../src/db/queries.js";
import { getTransactionsByType } from "../../src/indexerReads/queries.js";
import { underDailyRateLimit, clearedMinHold, passesFundingSourceCheck } from "../../src/scoring/antiGaming.js";

const mockInsertLedgerEntries = vi.mocked(insertLedgerEntries);
const mockGetTransactionsByType = vi.mocked(getTransactionsByType);
const mockUnderDailyRateLimit = vi.mocked(underDailyRateLimit);
const mockClearedMinHold = vi.mocked(clearedMinHold);
const mockPassesFundingSourceCheck = vi.mocked(passesFundingSourceCheck);

const CHAIN_ID = 11155111;
const WALLET = makeAddress(1);
const indexerDb = {} as DbClient;
const campaignDb = createBareMockDb<CampaignDbClient>();

/** Builds a fake vault_transactions row with sensible defaults, override what a test cares about. */
function tx(overrides: Partial<VaultTransaction>): VaultTransaction {
  return {
    id: makeTxHash(1),
    chainId: CHAIN_ID,
    wallet: WALLET,
    type: "REGISTERED",
    amount: null,
    toAddress: null,
    transactionHash: makeTxHash(1),
    blockNumber: 100n,
    timestamp: 1_700_000_000n,
    ...overrides,
  };
}

/** Routes getTransactionsByType's mock response by the `type` argument, so each test only needs to specify the event types it cares about. */
function mockTransactionsByType(byType: Record<string, VaultTransaction[]>) {
  mockGetTransactionsByType.mockImplementation(async (_db, _chainId, type) => byType[type] ?? []);
}

describe("runSepoliaScoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnderDailyRateLimit.mockResolvedValue(true);
    mockClearedMinHold.mockResolvedValue(true);
    mockPassesFundingSourceCheck.mockResolvedValue(true);
  });

  it("awards REGISTERED points for a registration event", async () => {
    mockTransactionsByType({ REGISTERED: [tx({ type: "REGISTERED", id: "reg-1" })] });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1);
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(
      campaignDb,
      expect.arrayContaining([
        expect.objectContaining({ actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "reg-1" }),
      ]),
    );
  });

  it("awards CORE_RECOVERY_CYCLE points for a completed recovery", async () => {
    mockTransactionsByType({ RECOVERY_EXECUTED: [tx({ type: "RECOVERY_EXECUTED", id: "rec-1" })] });

    await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(
      campaignDb,
      expect.arrayContaining([expect.objectContaining({ actionType: "CORE_RECOVERY_CYCLE", basePoints: 100 })]),
    );
  });

  it("awards the edge-case bonus for a zero-balance cancellation", async () => {
    mockTransactionsByType({ RECOVERY_CANCELLED: [tx({ type: "RECOVERY_CANCELLED", amount: 0n, id: "can-1" })] });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1);
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(
      campaignDb,
      expect.arrayContaining([expect.objectContaining({ actionType: "EDGE_CASE_REPRODUCTION", reference: "can-1" })]),
    );
  });

  it("does NOT award for a cancellation with a nonzero refund — only the zero-balance case counts", async () => {
    mockTransactionsByType({ RECOVERY_CANCELLED: [tx({ type: "RECOVERY_CANCELLED", amount: 5_000n })] });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
  });

  it("treats a null cancellation amount the same as zero", async () => {
    mockTransactionsByType({ RECOVERY_CANCELLED: [tx({ type: "RECOVERY_CANCELLED", amount: null })] });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1);
  });

  it("awards the three-attempt failure cycle exactly once, on the 3rd failure — not the 1st or 2nd", async () => {
    mockTransactionsByType({
      RECOVERY_FAILED: [
        tx({ type: "RECOVERY_FAILED", id: "fail-1" }),
        tx({ type: "RECOVERY_FAILED", id: "fail-2" }),
      ],
    });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
  });

  it("still awards only once even with more than 3 failures for the same wallet", async () => {
    mockTransactionsByType({
      RECOVERY_FAILED: Array.from({ length: 5 }, (_, i) => tx({ type: "RECOVERY_FAILED", id: `fail-${i}` })),
    });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1);
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(
      campaignDb,
      expect.arrayContaining([expect.objectContaining({ reference: `${WALLET.toLowerCase()}-three-attempt-cycle` })]),
    );
  });

  it("counts failures per wallet independently — one wallet's 3rd failure doesn't award for another's 2nd", async () => {
    const walletB = makeAddress(2);
    mockTransactionsByType({
      RECOVERY_FAILED: [
        tx({ type: "RECOVERY_FAILED", wallet: WALLET, id: "a1" }),
        tx({ type: "RECOVERY_FAILED", wallet: WALLET, id: "a2" }),
        tx({ type: "RECOVERY_FAILED", wallet: WALLET, id: "a3" }),
        tx({ type: "RECOVERY_FAILED", wallet: walletB, id: "b1" }),
        tx({ type: "RECOVERY_FAILED", wallet: walletB, id: "b2" }),
      ],
    });

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1); // only WALLET's 3rd failure qualifies
  });

  it("filters out entries for a wallet that fails the daily rate limit", async () => {
    mockTransactionsByType({ REGISTERED: [tx({ type: "REGISTERED" })] });
    mockUnderDailyRateLimit.mockResolvedValue(false);

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(campaignDb, []);
  });

  it("filters out entries that fail the funding-source check", async () => {
    mockTransactionsByType({ REGISTERED: [tx({ type: "REGISTERED" })] });
    mockPassesFundingSourceCheck.mockResolvedValue(false);

    const result = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
  });
});

describe("runMainnetRegistrationScoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnderDailyRateLimit.mockResolvedValue(true);
    mockClearedMinHold.mockResolvedValue(true);
    mockPassesFundingSourceCheck.mockResolvedValue(true);
  });

  it("skips a deposit strictly below the dust threshold", async () => {
    mockTransactionsByType({ DEPOSIT: [tx({ type: "DEPOSIT", amount: 999_999n })] }); // threshold is 1,000,000

    const result = await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
  });

  it("scores a deposit exactly at the dust threshold", async () => {
    mockTransactionsByType({ DEPOSIT: [tx({ type: "DEPOSIT", amount: 1_000_000n })] });

    const result = await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(1);
  });

  it("applies the mainnet phase weight to the awarded entry", async () => {
    mockTransactionsByType({ DEPOSIT: [tx({ type: "DEPOSIT", amount: 1_000_000n })] });

    await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(
      campaignDb,
      expect.arrayContaining([expect.objectContaining({ phase: "mainnet", weight: 3 })]),
    );
  });

  it("skips a qualifying deposit if it was withdrawn again within the min-hold window", async () => {
    mockTransactionsByType({ DEPOSIT: [tx({ type: "DEPOSIT", amount: 5_000_000n })] });
    mockClearedMinHold.mockResolvedValue(false);

    const result = await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(result.awarded).toBe(0);
  });

  it("passes chainId through to the min-hold check", async () => {
    mockTransactionsByType({ DEPOSIT: [tx({ type: "DEPOSIT", amount: 5_000_000n, timestamp: 42n })] });

    await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_ID, 0n);

    expect(mockClearedMinHold).toHaveBeenCalledWith(indexerDb, CHAIN_ID, WALLET, 42n);
  });
});
