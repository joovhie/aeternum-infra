/**
 * src/api/routes/bugReports.ts
 *
 * Category deliberately excludes anything security-related. This form is
 * for UI bugs, indexer lag, confusing states, docs errors — nothing that
 * touches contract security. That goes to security@aeternumvault.xyz only.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { CampaignDbClient } from "../../db/client.js";
import { insertBugReport } from "../../db/queries.js";

const CATEGORIES = ["ui", "indexer", "docs", "other"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;

const bugReportSchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  category: z.enum(CATEGORIES),
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  severity: z.enum(SEVERITIES),
});

export function bugReportsRoutes(db: CampaignDbClient) {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bugReportSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "invalid submission", details: parsed.error.flatten() }, 400);
    }

    const row = await insertBugReport(db, parsed.data);
    return c.json({ id: row.id, status: row.status }, 201);
  });

  app.get("/security-note", (c) =>
    c.json({
      note: "Found a bug touching contract security or funds? Do not submit it here — email security@aeternumvault.xyz directly.",
    }),
  );

  return app;
}
