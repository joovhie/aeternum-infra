import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAddress, createBareMockDb } from "../helpers/mocks.js";
import type { CampaignDbClient } from "../../src/db/client.js";

// campaignEnv is read directly by executor.ts (CAMPAIGN_POINTS_TO_WEI_RATE,
// CAMPAIGN_TREASURY_BUDGET_WEI) — vi.hoisted() gives us a mutable object we
// can adjust per test, since vi.mock's factory runs before normal imports
// and can't close over an ordinary top-level const.
const mockEnv = vi.hoisted(() => ({
  CAMPAIGN_POINTS_TO_WEI_RATE: 1_000n,
  CAMPAIGN_TREASURY_BUDGET_WEI: 1_000_000_000n,
}));

vi.mock("../../src/env.js", () => ({ campaignEnv: mockEnv }));

vi.mock("../../src/db/queries.js", () => ({
  getRedemptionByWallet: vi.fn(),
  getSnapshotForWallet: vi.fn(),
  createRedemptionRequest: vi.fn(),
  markRedemptionApproved: vi.fn(),
  getCommittedTreasuryWei: vi.fn(),
}));

vi.mock("../../src/redemption/treasury.js", () => ({
  proposeSafeTransaction: vi.fn(),
}));

import { requestRedemption, approveAndProposePayout } from "../../src/redemption/executor.js";
import {
  getRedemptionByWallet,
  getSnapshotForWallet,
  createRedemptionRequest,
  markRedemptionApproved,
  getCommittedTreasuryWei,
} from "../../src/db/queries.js";
import { proposeSafeTransaction } from "../../src/redemption/treasury.js";

const mockGetRedemptionByWallet = vi.mocked(getRedemptionByWallet);
const mockGetSnapshotForWallet = vi.mocked(getSnapshotForWallet);
const mockCreateRedemptionRequest = vi.mocked(createRedemptionRequest);
const mockMarkRedemptionApproved = vi.mocked(markRedemptionApproved);
const mockGetCommittedTreasuryWei = vi.mocked(getCommittedTreasuryWei);
const mockProposeSafeTransaction = vi.mocked(proposeSafeTransaction);

const WALLET = makeAddress(1);
const db = createBareMockDb<CampaignDbClient>();

describe("requestRedemption", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.CAMPAIGN_POINTS_TO_WEI_RATE = 1_000n;
    mockEnv.CAMPAIGN_TREASURY_BUDGET_WEI = 1_000_000_000n;
    mockGetCommittedTreasuryWei.mockResolvedValue(0n);
  });

  it("is idempotent — returns the existing request without creating a new one", async () => {
    mockGetRedemptionByWallet.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 500, ethAmountWei: "500000",
      status: "pending", requestedAt: new Date(), approvedAt: null, paidAt: null, txHash: null,
    });

    const result = await requestRedemption(db, WALLET);

    expect(result).toEqual({ ok: true, status: "already_requested", ethAmountWei: "500000" });
    expect(mockCreateRedemptionRequest).not.toHaveBeenCalled();
  });

  it("rejects when there's no frozen snapshot for the wallet", async () => {
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue(undefined);

    const result = await requestRedemption(db, WALLET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/snapshot/i);
  });

  it("rejects when the conversion rate hasn't been set yet", async () => {
    mockEnv.CAMPAIGN_POINTS_TO_WEI_RATE = 0n;
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue({
      id: "s1", wallet: WALLET, totalPoints: 500, frozenAt: new Date(),
    });

    const result = await requestRedemption(db, WALLET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/conversion rate/i);
  });

  it("computes points × rate correctly and creates the request", async () => {
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue({
      id: "s1", wallet: WALLET, totalPoints: 500, frozenAt: new Date(),
    });
    mockCreateRedemptionRequest.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 500, ethAmountWei: "500000",
      status: "pending", requestedAt: new Date(), approvedAt: null, paidAt: null, txHash: null,
    });

    const result = await requestRedemption(db, WALLET);

    // 500 points × 1,000 wei/point = 500,000 wei
    expect(result).toEqual({ ok: true, status: "requested", ethAmountWei: "500000" });
    expect(mockCreateRedemptionRequest).toHaveBeenCalledWith(db, {
      wallet: WALLET,
      pointsRedeemed: 500,
      ethAmountWei: "500000",
    });
  });

  it("scales the payout down pro-rata when the raw amount would exceed the remaining budget", async () => {
    mockEnv.CAMPAIGN_TREASURY_BUDGET_WEI = 100n;
    mockGetCommittedTreasuryWei.mockResolvedValue(80n); // 20n remaining
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue({
      id: "s1", wallet: WALLET, totalPoints: 50, frozenAt: new Date(), // 50 × 1,000 = 50,000 raw — way over the 20n remaining
    });
    mockCreateRedemptionRequest.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 50, ethAmountWei: "20",
      status: "pending", requestedAt: new Date(), approvedAt: null, paidAt: null, txHash: null,
    });

    const result = await requestRedemption(db, WALLET);

    expect(result).toEqual({ ok: true, status: "requested", ethAmountWei: "20" });
    expect(mockCreateRedemptionRequest).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ethAmountWei: "20" }),
    );
  });

  it("rejects when the budget is already fully committed", async () => {
    mockEnv.CAMPAIGN_TREASURY_BUDGET_WEI = 100n;
    mockGetCommittedTreasuryWei.mockResolvedValue(100n); // 0n remaining
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue({
      id: "s1", wallet: WALLET, totalPoints: 10, frozenAt: new Date(),
    });

    const result = await requestRedemption(db, WALLET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/budget/i);
    expect(mockCreateRedemptionRequest).not.toHaveBeenCalled();
  });

  it("reports the race case when createRedemptionRequest finds a row already exists", async () => {
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    mockGetSnapshotForWallet.mockResolvedValue({
      id: "s1", wallet: WALLET, totalPoints: 10, frozenAt: new Date(),
    });
    mockCreateRedemptionRequest.mockResolvedValue(undefined); // onConflictDoNothing found an existing row

    const result = await requestRedemption(db, WALLET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already exists/i);
  });
});

describe("approveAndProposePayout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when there's no redemption request for the wallet", async () => {
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    await expect(approveAndProposePayout(db, WALLET)).rejects.toThrow(/no pending redemption/i);
  });

  it("throws when the request exists but isn't pending (e.g. already paid)", async () => {
    mockGetRedemptionByWallet.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 500, ethAmountWei: "500000",
      status: "paid", requestedAt: new Date(), approvedAt: new Date(), paidAt: new Date(), txHash: "0xabc",
    });
    await expect(approveAndProposePayout(db, WALLET)).rejects.toThrow(/no pending redemption/i);
  });

  it("approves and proposes the payout with the exact amount on the record", async () => {
    mockGetRedemptionByWallet.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 500, ethAmountWei: "500000",
      status: "pending", requestedAt: new Date(), approvedAt: null, paidAt: null, txHash: null,
    });

    await approveAndProposePayout(db, WALLET);

    expect(mockMarkRedemptionApproved).toHaveBeenCalledWith(db, WALLET);
    expect(mockProposeSafeTransaction).toHaveBeenCalledWith({
      wallet: WALLET,
      amountWei: 500_000n,
      redemptionId: "r1",
    });
  });
});
