import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBareMockDb } from "../../helpers/mocks.js";
import type { CampaignDbClient } from "../../../src/db/client.js";

vi.mock("../../../src/db/queries.js", () => ({
  getLeaderboard: vi.fn(async () => []),
}));

import { leaderboardRoutes } from "../../../src/api/routes/leaderboard.js";
import { getLeaderboard } from "../../../src/db/queries.js";

const mockGetLeaderboard = vi.mocked(getLeaderboard);
const db = createBareMockDb<CampaignDbClient>();
const app = leaderboardRoutes(db);

describe("GET /leaderboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLeaderboard.mockResolvedValue([{ wallet: "0x1", total: 100 }]);
  });

  it("defaults to a limit of 100 when no query param is given", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(mockGetLeaderboard).toHaveBeenCalledWith(db, 100);
  });

  it("passes through an explicit limit", async () => {
    await app.request("/?limit=5");
    expect(mockGetLeaderboard).toHaveBeenCalledWith(db, 5);
  });

  it("caps the limit at 500 even if a larger value is requested", async () => {
    await app.request("/?limit=99999");
    expect(mockGetLeaderboard).toHaveBeenCalledWith(db, 500);
  });

  it("returns the rows under a leaderboard key", async () => {
    const res = await app.request("/");
    const body = await res.json();
    expect(body).toEqual({ leaderboard: [{ wallet: "0x1", total: 100 }] });
  });
});
