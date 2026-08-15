import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBareMockDb, makeAddress } from "../../helpers/mocks.js";
import type { CampaignDbClient } from "../../../src/db/client.js";

vi.mock("../../../src/db/queries.js", () => ({
  getOrCreateReferralCode: vi.fn(),
  getReferrerByCode: vi.fn(),
  countReferralCredits: vi.fn(),
  insertReferralCredit: vi.fn(),
  insertLedgerEntries: vi.fn(async () => []),
}));

vi.mock("../../../src/scoring/antiGaming.js", () => ({
  underDailyRateLimit: vi.fn(async () => true),
  passesFundingSourceCheck: vi.fn(async () => true),
}));

// scoring/weights.js is deliberately left un-mocked — it's pure, already
// covered in weights.test.ts, and using the real referral decay curve here
// gives confidence the route is wired to it correctly, not just to a mock
// that agrees with itself.
import { referralsRoutes } from "../../../src/api/routes/referrals.js";
import {
  getOrCreateReferralCode,
  getReferrerByCode,
  countReferralCredits,
  insertReferralCredit,
  insertLedgerEntries,
} from "../../../src/db/queries.js";
import { underDailyRateLimit, passesFundingSourceCheck } from "../../../src/scoring/antiGaming.js";
import { REFERRAL_BASE_POINTS, PHASE_WEIGHTS } from "../../../src/scoring/weights.js";

const mockGetOrCreateReferralCode = vi.mocked(getOrCreateReferralCode);
const mockGetReferrerByCode = vi.mocked(getReferrerByCode);
const mockCountReferralCredits = vi.mocked(countReferralCredits);
const mockInsertReferralCredit = vi.mocked(insertReferralCredit);
const mockInsertLedgerEntries = vi.mocked(insertLedgerEntries);
const mockUnderDailyRateLimit = vi.mocked(underDailyRateLimit);
const mockPassesFundingSourceCheck = vi.mocked(passesFundingSourceCheck);

const db = createBareMockDb<CampaignDbClient>();
const app = referralsRoutes(db);
const REFERRER = makeAddress(1);
const REFERRED = makeAddress(2);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /referrals/:wallet/code", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed wallet", async () => {
    const res = await app.request("/not-a-wallet/code");
    expect(res.status).toBe(400);
  });

  it("returns the code for a valid wallet", async () => {
    mockGetOrCreateReferralCode.mockResolvedValue("abc12345");
    const res = await app.request(`/${REFERRER}/code`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.code).toBe("abc12345");
  });
});

describe("POST /referrals/credit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnderDailyRateLimit.mockResolvedValue(true);
    mockPassesFundingSourceCheck.mockResolvedValue(true);
    mockGetReferrerByCode.mockResolvedValue(REFERRER);
    mockCountReferralCredits.mockResolvedValue(0);
  });

  it("rejects a body missing required fields", async () => {
    const res = await post("/credit", { code: "abc" }); // no referredWallet
    expect(res.status).toBe(400);
  });

  it("rejects an unrecognized code", async () => {
    mockGetReferrerByCode.mockResolvedValue(undefined);
    const res = await post("/credit", { code: "nope", referredWallet: REFERRED });
    expect(res.status).toBe(404);
  });

  it("rejects self-referral — a wallet crediting its own code", async () => {
    mockGetReferrerByCode.mockResolvedValue(REFERRER);
    const res = await post("/credit", { code: "abc", referredWallet: REFERRER });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/refer yourself/i);
    expect(mockInsertReferralCredit).not.toHaveBeenCalled();
  });

  it("rejects self-referral regardless of address casing", async () => {
    const upperReferrer = REFERRER.toUpperCase() as `0x${string}`;
    mockGetReferrerByCode.mockResolvedValue(REFERRER); // stored lowercase
    const res = await post("/credit", { code: "abc", referredWallet: upperReferrer });
    expect(res.status).toBe(400);
  });

  it("blocks the credit when the referrer has hit the daily rate limit", async () => {
    mockUnderDailyRateLimit.mockResolvedValue(false);
    const res = await post("/credit", { code: "abc", referredWallet: REFERRED });
    expect(res.status).toBe(429);
  });

  it("blocks the credit when the referred wallet fails the funding-source check", async () => {
    mockPassesFundingSourceCheck.mockResolvedValue(false);
    const res = await post("/credit", { code: "abc", referredWallet: REFERRED });
    expect(res.status).toBe(400);
  });

  it("credits at full tier for a referrer's first referral and writes the matching ledger entry", async () => {
    mockCountReferralCredits.mockResolvedValue(0); // 0 existing credits → full tier
    mockInsertReferralCredit.mockResolvedValue({
      id: "credit-1",
      referrerWallet: REFERRER,
      referredWallet: REFERRED,
      tier: "full",
      basePoints: REFERRAL_BASE_POINTS,
      weightedPoints: Math.round(REFERRAL_BASE_POINTS * PHASE_WEIGHTS.mainnet),
      creditedAt: new Date(),
    });

    const res = await post("/credit", { code: "abc", referredWallet: REFERRED });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ credited: true, tier: "full", basePoints: REFERRAL_BASE_POINTS });
    expect(mockInsertLedgerEntries).toHaveBeenCalledWith(db, [
      expect.objectContaining({
        wallet: REFERRER,
        actionType: "REFERRAL",
        basePoints: REFERRAL_BASE_POINTS,
        weight: PHASE_WEIGHTS.mainnet,
        reference: "credit-1",
      }),
    ]);
  });

  it("credits at floor tier once the referrer is past 20 prior credits", async () => {
    mockCountReferralCredits.mockResolvedValue(25);
    const expectedBase = Math.round(REFERRAL_BASE_POINTS * 0.1);
    mockInsertReferralCredit.mockResolvedValue({
      id: "credit-2",
      referrerWallet: REFERRER,
      referredWallet: REFERRED,
      tier: "floor",
      basePoints: expectedBase,
      weightedPoints: Math.round(expectedBase * PHASE_WEIGHTS.mainnet),
      creditedAt: new Date(),
    });

    const res = await post("/credit", { code: "abc", referredWallet: REFERRED });
    const body = await res.json();

    expect(body.tier).toBe("floor");
    expect(body.basePoints).toBe(expectedBase);
  });

  it("returns 409 when the referred wallet has already been credited to someone", async () => {
    mockInsertReferralCredit.mockResolvedValue(undefined); // onConflictDoNothing hit the unique constraint

    const res = await post("/credit", { code: "abc", referredWallet: REFERRED });

    expect(res.status).toBe(409);
    expect(mockInsertLedgerEntries).not.toHaveBeenCalled();
  });
});
