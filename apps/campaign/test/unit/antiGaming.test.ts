import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CampaignDbClient } from "../../src/db/client.js";
import type { DbClient } from "@aeternum/db";
import { chainable, makeAddress } from "../helpers/mocks.js";

// underDailyRateLimit builds its query inline rather than calling a named
// helper, so it's tested against a chainable() mock of db.select rather
// than a vi.mock'd module.
import { underDailyRateLimit, clearedMinHold, passesFundingSourceCheck } from "../../src/scoring/antiGaming.js";

vi.mock("../../src/indexerReads/queries.js", () => ({
  hadEarlyWithdrawal: vi.fn(),
}));

vi.mock("../../src/env.js", () => ({
  campaignEnv: { CAMPAIGN_MIN_HOLD_SECONDS: 86_400 },
}));

import { hadEarlyWithdrawal } from "../../src/indexerReads/queries.js";

const mockHadEarlyWithdrawal = vi.mocked(hadEarlyWithdrawal);
const WALLET = makeAddress(1);

describe("underDailyRateLimit", () => {
  function dbReturning(count: number): CampaignDbClient {
    return { select: vi.fn(() => chainable([{ count }])) } as unknown as CampaignDbClient;
  }

  it("allows the action when today's count is under the limit", async () => {
    const result = await underDailyRateLimit(dbReturning(0), WALLET);
    expect(result).toBe(true);
  });

  it("allows the action at 19 actions today (one below the limit)", async () => {
    const result = await underDailyRateLimit(dbReturning(19), WALLET);
    expect(result).toBe(true);
  });

  it("blocks the action at exactly 20 actions today", async () => {
    const result = await underDailyRateLimit(dbReturning(20), WALLET);
    expect(result).toBe(false);
  });

  it("blocks the action above the limit", async () => {
    const result = await underDailyRateLimit(dbReturning(50), WALLET);
    expect(result).toBe(false);
  });

  it("treats a missing count row as zero rather than throwing", async () => {
    const db = { select: vi.fn(() => chainable([])) } as unknown as CampaignDbClient;
    const result = await underDailyRateLimit(db, WALLET);
    expect(result).toBe(true);
  });
});

describe("clearedMinHold", () => {
  const indexerDb = {} as DbClient;

  beforeEach(() => {
    mockHadEarlyWithdrawal.mockReset();
  });

  it("returns true when no early withdrawal occurred", async () => {
    mockHadEarlyWithdrawal.mockResolvedValue(false);
    const result = await clearedMinHold(indexerDb, 11155111, WALLET, 1_000n);
    expect(result).toBe(true);
  });

  it("returns false when an early withdrawal occurred", async () => {
    mockHadEarlyWithdrawal.mockResolvedValue(true);
    const result = await clearedMinHold(indexerDb, 11155111, WALLET, 1_000n);
    expect(result).toBe(false);
  });

  it("passes chainId, wallet, timestamp, and the configured min-hold seconds through unchanged", async () => {
    mockHadEarlyWithdrawal.mockResolvedValue(false);
    await clearedMinHold(indexerDb, 11155111, WALLET, 12_345n);
    expect(mockHadEarlyWithdrawal).toHaveBeenCalledWith(indexerDb, 11155111, WALLET, 12_345n, 86_400);
  });
});

describe("passesFundingSourceCheck", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // logger.warn writes to stderr
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // This function is a known, documented gap (see the file's own header
  // comment) — it always allows the wallet through. This test exists to
  // make that a visible, intentional fact: if someone later implements
  // real funding-source clustering and this test starts failing, that's
  // the signal to update the test alongside the implementation, not a
  // regression to silently work around.
  it("always returns true, since funding-source clustering isn't implemented yet", async () => {
    const result = await passesFundingSourceCheck(WALLET);
    expect(result).toBe(true);
  });

  it("logs a warning every time, so the gap stays visible in production logs", async () => {
    await passesFundingSourceCheck(WALLET);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
