import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBareMockDb, makeAddress } from "../../helpers/mocks.js";
import type { CampaignDbClient } from "../../../src/db/client.js";

const mockEnv = vi.hoisted(() => ({
  CAMPAIGN_ADMIN_API_KEY: "test-admin-secret",
}));

vi.mock("../../../src/env.js", () => ({ campaignEnv: mockEnv }));

vi.mock("../../../src/db/queries.js", () => ({
  getRedemptionByWallet: vi.fn(),
}));

vi.mock("../../../src/redemption/executor.js", () => ({
  requestRedemption: vi.fn(),
  approveAndProposePayout: vi.fn(),
}));

import { redemptionRoutes } from "../../../src/api/routes/redemption.js";
import { getRedemptionByWallet } from "../../../src/db/queries.js";
import { requestRedemption, approveAndProposePayout } from "../../../src/redemption/executor.js";

const mockGetRedemptionByWallet = vi.mocked(getRedemptionByWallet);
const mockRequestRedemption = vi.mocked(requestRedemption);
const mockApproveAndProposePayout = vi.mocked(approveAndProposePayout);

const db = createBareMockDb<CampaignDbClient>();
const app = redemptionRoutes(db);
const WALLET = makeAddress(1);

describe("GET /redemption/:wallet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed wallet", async () => {
    const res = await app.request("/not-a-wallet");
    expect(res.status).toBe(400);
  });

  it("returns null when there's no redemption on file", async () => {
    mockGetRedemptionByWallet.mockResolvedValue(undefined);
    const res = await app.request(`/${WALLET}`);
    const body = (await res.json()) as { redemption: null };
    expect(body).toEqual({ redemption: null });
  });

  it("returns the redemption row when one exists", async () => {
    mockGetRedemptionByWallet.mockResolvedValue({
      id: "r1", wallet: WALLET, pointsRedeemed: 100, ethAmountWei: "100000",
      status: "pending", requestedAt: new Date(), approvedAt: null, paidAt: null, txHash: null,
    });
    const res = await app.request(`/${WALLET}`);
    const body = (await res.json()) as { redemption: { id: string } };
    expect(body.redemption.id).toBe("r1");
  });
});

describe("POST /redemption/:wallet/claim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed wallet", async () => {
    const res = await app.request("/not-a-wallet/claim", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 400 with the executor's reason when the claim is rejected", async () => {
    mockRequestRedemption.mockResolvedValue({ ok: false, reason: "no frozen snapshot found for this wallet" });
    const res = await app.request(`/${WALLET}/claim`, { method: "POST" });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/snapshot/i);
  });

  it("returns 200 with the executor's result on success", async () => {
    mockRequestRedemption.mockResolvedValue({ ok: true, status: "requested", ethAmountWei: "50000" });
    const res = await app.request(`/${WALLET}/claim`, { method: "POST" });
    const body = (await res.json()) as { ethAmountWei: string };

    expect(res.status).toBe(200);
    expect(body.ethAmountWei).toBe("50000");
  });
});

describe("POST /redemption/:wallet/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.CAMPAIGN_ADMIN_API_KEY = "test-admin-secret";
  });

  it("rejects with 401 when no admin key header is sent", async () => {
    const res = await app.request(`/${WALLET}/approve`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(mockApproveAndProposePayout).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the wrong admin key is sent", async () => {
    const res = await app.request(`/${WALLET}/approve`, {
      method: "POST",
      headers: { "x-admin-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 even with a correct-looking header if no admin key is configured at all", async () => {
    // @ts-expect-error — intentionally simulating the unconfigured state
    mockEnv.CAMPAIGN_ADMIN_API_KEY = undefined;
    const res = await app.request(`/${WALLET}/approve`, {
      method: "POST",
      headers: { "x-admin-key": "" },
    });
    expect(res.status).toBe(401);
  });

  it("proceeds with the correct admin key", async () => {
    mockApproveAndProposePayout.mockResolvedValue(undefined);
    const res = await app.request(`/${WALLET}/approve`, {
      method: "POST",
      headers: { "x-admin-key": "test-admin-secret" },
    });
    const body = (await res.json()) as { approved: boolean };

    expect(res.status).toBe(200);
    expect(body).toEqual({ approved: true });
    expect(mockApproveAndProposePayout).toHaveBeenCalledWith(db, WALLET);
  });

  it("rejects a malformed wallet even with a valid admin key", async () => {
    const res = await app.request("/not-a-wallet/approve", {
      method: "POST",
      headers: { "x-admin-key": "test-admin-secret" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 with the error message when the executor throws (e.g. nothing pending)", async () => {
    mockApproveAndProposePayout.mockRejectedValue(new Error("No pending redemption for " + WALLET));
    const res = await app.request(`/${WALLET}/approve`, {
      method: "POST",
      headers: { "x-admin-key": "test-admin-secret" },
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/no pending redemption/i);
  });
});
