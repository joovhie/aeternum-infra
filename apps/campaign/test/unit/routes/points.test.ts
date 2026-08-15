import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBareMockDb, makeAddress } from "../../helpers/mocks.js";
import type { CampaignDbClient } from "../../../src/db/client.js";

vi.mock("../../../src/db/queries.js", () => ({
  getPointsByWallet: vi.fn(async () => []),
  getLedgerForWallet: vi.fn(async () => []),
}));

import { pointsRoutes } from "../../../src/api/routes/points.js";
import { getPointsByWallet, getLedgerForWallet } from "../../../src/db/queries.js";

const mockGetPointsByWallet = vi.mocked(getPointsByWallet);
const mockGetLedgerForWallet = vi.mocked(getLedgerForWallet);
const db = createBareMockDb<CampaignDbClient>();
const app = pointsRoutes(db);
const WALLET = makeAddress(1);

describe("GET /points/:wallet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed wallet address", async () => {
    const res = await app.request("/not-an-address");
    expect(res.status).toBe(400);
  });

  it("sums the per-phase totals into a combined total", async () => {
    mockGetPointsByWallet.mockResolvedValue([
      { phase: "sepolia", total: 40 },
      { phase: "mainnet", total: 160 },
    ]);
    mockGetLedgerForWallet.mockResolvedValue([]);

    const res = await app.request(`/${WALLET}`);
    const body = (await res.json()) as { total: number; byPhase: Array<{ phase: string; total: number }> };

    expect(res.status).toBe(200);
    expect(body.total).toBe(200);
    expect(body.byPhase).toHaveLength(2);
  });

  it("returns zero total with no ledger entries at all", async () => {
    mockGetPointsByWallet.mockResolvedValue([]);
    mockGetLedgerForWallet.mockResolvedValue([]);

    const res = await app.request(`/${WALLET}`);
    const body = (await res.json()) as { total: number };

    expect(body.total).toBe(0);
  });

  it("lowercases the wallet in the response regardless of input casing", async () => {
    mockGetPointsByWallet.mockResolvedValue([]);
    mockGetLedgerForWallet.mockResolvedValue([]);

    const upper = `0x${"A".repeat(40)}`;
    const res = await app.request(`/${upper}`);
    const body = (await res.json()) as { wallet: string };

    expect(body.wallet).toBe(upper.toLowerCase());
  });
});
