import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBareMockDb, makeAddress } from "../../helpers/mocks.js";
import type { CampaignDbClient } from "../../../src/db/client.js";

vi.mock("../../../src/db/queries.js", () => ({
  insertBugReport: vi.fn(async () => ({ id: "b1", status: "submitted" })),
}));

import { bugReportsRoutes } from "../../../src/api/routes/bugReports.js";
import { insertBugReport } from "../../../src/db/queries.js";

const mockInsertBugReport = vi.mocked(insertBugReport);
const db = createBareMockDb<CampaignDbClient>();
const app = bugReportsRoutes(db);
const WALLET = makeAddress(1);

function validBody(overrides = {}) {
  return {
    wallet: WALLET,
    category: "ui",
    title: "Button misaligned on mobile",
    description: "The claim button overlaps the footer on narrow viewports.",
    severity: "low",
    ...overrides,
  };
}

describe("POST /bug-reports", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a valid submission and returns 201", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(res.status).toBe(201);
    expect(mockInsertBugReport).toHaveBeenCalledWith(db, validBody());
  });

  it("rejects a category outside the allowed list — specifically, there's no way to submit a 'security' report through this route", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ category: "security" })),
    });

    expect(res.status).toBe(400);
    expect(mockInsertBugReport).not.toHaveBeenCalled();
  });

  it("rejects a malformed wallet address", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ wallet: "not-a-wallet" })),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a title that's too short", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ title: "hi" })),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unparseable body rather than throwing", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("GET /security-note points to the security email, not this route, for real vulnerabilities", async () => {
    const res = await app.request("/security-note");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.note).toContain("security@aeternumvault.xyz");
  });
});
