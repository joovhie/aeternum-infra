import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAddress, createBareMockDb } from "../helpers/mocks.js";
import type { DbClient, Vault } from "@aeternum/db";
import type { CampaignDbClient } from "../../src/db/client.js";

vi.mock("../../src/indexerReads/queries.js", () => ({
  getLiveVaults: vi.fn(async () => []),
}));

vi.mock("../../src/db/queries.js", () => ({
  insertLedgerEntries: vi.fn(async (_db, entries) => entries),
}));

import { runLivenessCheckpoint } from "../../src/scoring/livenessCheckpoint.js";
import { getLiveVaults } from "../../src/indexerReads/queries.js";
import { insertLedgerEntries } from "../../src/db/queries.js";
import { MAINNET_ACTION_POINTS, PHASE_WEIGHTS } from "../../src/scoring/weights.js";

const mockGetLiveVaults = vi.mocked(getLiveVaults);
const mockInsertLedgerEntries = vi.mocked(insertLedgerEntries);

const CHAIN_ID = 1;
const MONTH = "2026-08";
const indexerDb = {} as DbClient;
const campaignDb = createBareMockDb<CampaignDbClient>();

function vault(overrides: Partial<Vault>): Vault {
  return {
    id: `${CHAIN_ID}-${makeAddress(1)}`,
    chainId: CHAIN_ID,
    wallet: makeAddress(1),
    backupAddress: makeAddress(9),
    inactivityPeriod: 31_536_000n,
    lastActivityTimestamp: 0n,
    isRecovered: false,
    isAbandoned: false,
    isCancelled: false,
    createdAtBlock: 1n,
    ...overrides,
  };
}

describe("runLivenessCheckpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awards a checkpoint for a vault with a real configured timer", async () => {
    mockGetLiveVaults.mockResolvedValue([vault({})]);

    const result = await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_ID, MONTH);

    expect(result.awarded).toBe(1);
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(campaignDb, [
      expect.objectContaining({
        actionType: "LIVENESS_CHECKPOINT",
        basePoints: MAINNET_ACTION_POINTS.LIVENESS_CHECKPOINT,
        weight: PHASE_WEIGHTS.mainnet,
      }),
    ]);
  });

  it("excludes a vault with inactivityPeriod of zero — not a genuinely configured timer", async () => {
    mockGetLiveVaults.mockResolvedValue([vault({ inactivityPeriod: 0n })]);

    const result = await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_ID, MONTH);

    expect(result.awarded).toBe(0);
  });

  it("builds the dedupe reference from the lowercased wallet and the given month", async () => {
    const upperWallet = makeAddress(2).toUpperCase() as `0x${string}`;
    mockGetLiveVaults.mockResolvedValue([vault({ wallet: upperWallet })]);

    await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_ID, MONTH);

    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(campaignDb, [
      expect.objectContaining({ reference: `${upperWallet.toLowerCase()}-liveness-${MONTH}` }),
    ]);
  });

  it("scores multiple qualifying vaults independently", async () => {
    mockGetLiveVaults.mockResolvedValue([
      vault({ wallet: makeAddress(1) }),
      vault({ wallet: makeAddress(2) }),
      vault({ wallet: makeAddress(3), inactivityPeriod: 0n }), // excluded
    ]);

    const result = await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_ID, MONTH);

    expect(result.awarded).toBe(2);
  });

  it("passes the chain id through to getLiveVaults unchanged", async () => {
    mockGetLiveVaults.mockResolvedValue([]);
    await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_ID, MONTH);
    expect(mockGetLiveVaults).toHaveBeenCalledWith(indexerDb, CHAIN_ID);
  });
});
