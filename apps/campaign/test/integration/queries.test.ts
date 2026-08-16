/**
 * test/integration/queries.test.ts
 *
 * Runs the real db/queries.ts functions against a real (in-process,
 * WASM-compiled) Postgres via pglite — see test/helpers/pglite.ts for why.
 * This is specifically for the behavior mocks can't verify: does a
 * duplicate insert actually get rejected by the unique constraint, does
 * an upsert actually update in place, does a SUM/GROUP BY actually
 * aggregate correctly.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, truncateAll } from "../helpers/pglite.js";
import {
  insertLedgerEntries,
  getPointsByWallet,
  getLedgerForWallet,
  getLeaderboard,
  getAllWalletTotals,
  insertBugReport,
  reviewBugReport,
  getOrCreateReferralCode,
  getReferrerByCode,
  countReferralCredits,
  insertReferralCredit,
  upsertSocialBonus,
  writeSnapshot,
  getSnapshotForWallet,
  getRedemptionByWallet,
  createRedemptionRequest,
  markRedemptionApproved,
  markRedemptionPaid,
  getCommittedTreasuryWei,
} from "../../src/db/queries.js";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
}, 15_000); // WASM cold start is ~4.5s — give it real headroom rather than flake on slow CI

afterAll(async () => {
  await testDb.client.close();
});

beforeEach(async () => {
  await truncateAll(testDb.client);
});

const db = () => testDb.db;

describe("points ledger", () => {
  it("rejects a duplicate (wallet, actionType, reference) via the real unique constraint", async () => {
    const entry = { wallet: "0xAAA", phase: "sepolia" as const, actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx1" };

    const first = await insertLedgerEntries(db(), [entry]);
    const second = await insertLedgerEntries(db(), [entry]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // real constraint rejected it, not just a mock agreeing with itself
  });

  it("allows the same wallet and actionType with a different reference — the constraint is on the full triple", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xAAA", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx1" },
    ]);
    const second = await insertLedgerEntries(db(), [
      { wallet: "0xAAA", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx2" },
    ]);

    expect(second).toHaveLength(1);
  });

  it("stores lowercased wallet regardless of input casing", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xABCDEF0000000000000000000000000000000001", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx1" },
    ]);
    const rows = await getLedgerForWallet(db(), "0xabcdef0000000000000000000000000000000001");
    expect(rows).toHaveLength(1);
  });

  it("computes weightedPoints as basePoints × weight, real SQL arithmetic not JS math", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xAAA", phase: "mainnet", actionType: "REGISTER_DEPOSIT", basePoints: 50, weight: 3, reference: "tx1" },
    ]);
    const rows = await getLedgerForWallet(db(), "0xAAA");
    expect(rows[0].weightedPoints).toBe(150);
  });

  it("getPointsByWallet aggregates real totals grouped by phase", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xAAA", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx1" },
      { wallet: "0xAAA", phase: "sepolia", actionType: "CORE_RECOVERY_CYCLE", basePoints: 100, weight: 1, reference: "tx2" },
      { wallet: "0xAAA", phase: "mainnet", actionType: "REGISTER_DEPOSIT", basePoints: 50, weight: 3, reference: "tx3" },
    ]);

    const byPhase = await getPointsByWallet(db(), "0xAAA");
    const sepolia = byPhase.find((p) => p.phase === "sepolia");
    const mainnet = byPhase.find((p) => p.phase === "mainnet");

    expect(sepolia?.total).toBe(110);
    expect(mainnet?.total).toBe(150);
  });

  it("getLeaderboard orders by real total descending", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xLOW", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "tx1" },
      { wallet: "0xHIGH", phase: "sepolia", actionType: "CORE_RECOVERY_CYCLE", basePoints: 100, weight: 1, reference: "tx2" },
    ]);

    const board = await getLeaderboard(db(), 10);

    expect(board[0].wallet).toBe("0xhigh");
    expect(board[1].wallet).toBe("0xlow");
  });

  it("getAllWalletTotals returns every wallet, not just a top-N page", async () => {
    await insertLedgerEntries(db(), [
      { wallet: "0xA", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "t1" },
      { wallet: "0xB", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "t2" },
      { wallet: "0xC", phase: "sepolia", actionType: "REGISTERED", basePoints: 10, weight: 1, reference: "t3" },
    ]);

    const totals = await getAllWalletTotals(db());
    expect(totals).toHaveLength(3);
  });
});

describe("bug reports", () => {
  it("inserts and later updates status/points on real review", async () => {
    const report = await insertBugReport(db(), {
      wallet: "0xAAA", category: "ui", title: "Button misaligned", description: "Overlaps footer on mobile", severity: "low",
    });
    expect(report.status).toBe("submitted");

    const reviewed = await reviewBugReport(db(), report.id, { status: "accepted", reviewedBy: "founder", pointsAwarded: 25 });
    expect(reviewed?.status).toBe("accepted");
    expect(reviewed?.pointsAwarded).toBe(25);
  });
});

describe("referral codes and credits", () => {
  it("getOrCreateReferralCode is truly idempotent — same wallet always gets the same code, never a second row", async () => {
    const first = await getOrCreateReferralCode(db(), "0xAAA");
    const second = await getOrCreateReferralCode(db(), "0xAAA");
    expect(first).toBe(second);
  });

  it("getReferrerByCode resolves a generated code back to its wallet", async () => {
    const code = await getOrCreateReferralCode(db(), "0xAAA");
    const referrer = await getReferrerByCode(db(), code);
    expect(referrer).toBe("0xaaa");
  });

  it("rejects a second credit for the same referred wallet — even to a different referrer", async () => {
    const first = await insertReferralCredit(db(), {
      referrerWallet: "0xREF1", referredWallet: "0xNEW", tier: "full", basePoints: 30, weightedPoints: 90,
    });
    const second = await insertReferralCredit(db(), {
      referrerWallet: "0xREF2", referredWallet: "0xNEW", tier: "full", basePoints: 30, weightedPoints: 90,
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("countReferralCredits reflects only real, persisted credits", async () => {
    await insertReferralCredit(db(), { referrerWallet: "0xREF", referredWallet: "0xA", tier: "full", basePoints: 30, weightedPoints: 90 });
    await insertReferralCredit(db(), { referrerWallet: "0xREF", referredWallet: "0xB", tier: "full", basePoints: 30, weightedPoints: 90 });

    const count = await countReferralCredits(db(), "0xREF");
    expect(count).toBe(2);
  });
});

describe("social bonus", () => {
  it("upsertSocialBonus is safe to call twice for the same wallet+quest without erroring", async () => {
    await upsertSocialBonus(db(), { wallet: "0xAAA", galxeQuestId: "q1", points: 5 });
    await expect(upsertSocialBonus(db(), { wallet: "0xAAA", galxeQuestId: "q1", points: 5 })).resolves.not.toThrow();
  });
});

describe("snapshots", () => {
  it("writeSnapshot upserts in place — a re-run with a new total updates rather than duplicating", async () => {
    await writeSnapshot(db(), "0xAAA", 100);
    await writeSnapshot(db(), "0xAAA", 250);

    const snap = await getSnapshotForWallet(db(), "0xAAA");
    expect(snap?.totalPoints).toBe(250);

    const all = await db().select().from((await import("../../src/db/schema.js")).snapshots);
    expect(all.filter((w) => w.wallet === "0xaaa")).toHaveLength(1);
  });
});

describe("redemptions", () => {
  it("rejects a second redemption request for a wallet that already has one", async () => {
    const first = await createRedemptionRequest(db(), { wallet: "0xAAA", pointsRedeemed: 100, ethAmountWei: "1000" });
    const second = await createRedemptionRequest(db(), { wallet: "0xAAA", pointsRedeemed: 999, ethAmountWei: "9999" });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();

    const stored = await getRedemptionByWallet(db(), "0xAAA");
    expect(stored?.pointsRedeemed).toBe(100); // the first request's values, not the rejected second attempt's
  });

  it("markRedemptionApproved only moves a pending request to approved", async () => {
    await createRedemptionRequest(db(), { wallet: "0xAAA", pointsRedeemed: 100, ethAmountWei: "1000" });
    await markRedemptionApproved(db(), "0xAAA");

    const row = await getRedemptionByWallet(db(), "0xAAA");
    expect(row?.status).toBe("approved");
    expect(row?.approvedAt).not.toBeNull();
  });

  it("markRedemptionPaid records the tx hash and final status", async () => {
    await createRedemptionRequest(db(), { wallet: "0xAAA", pointsRedeemed: 100, ethAmountWei: "1000" });
    await markRedemptionPaid(db(), "0xAAA", "0xdeadbeef");

    const row = await getRedemptionByWallet(db(), "0xAAA");
    expect(row?.status).toBe("paid");
    expect(row?.txHash).toBe("0xdeadbeef");
  });

  it("getCommittedTreasuryWei sums only approved/paid rows, real BigInt arithmetic across real rows", async () => {
    await createRedemptionRequest(db(), { wallet: "0xA", pointsRedeemed: 100, ethAmountWei: "1000" });
    await createRedemptionRequest(db(), { wallet: "0xB", pointsRedeemed: 100, ethAmountWei: "2000" });
    await createRedemptionRequest(db(), { wallet: "0xC", pointsRedeemed: 100, ethAmountWei: "5000" });

    await markRedemptionApproved(db(), "0xA");
    await markRedemptionPaid(db(), "0xB", "0xhash");
    // 0xC stays pending — should NOT count toward committed spend

    const committed = await getCommittedTreasuryWei(db());
    expect(committed).toBe(3000n);
  });
});
