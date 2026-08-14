/**
 * src/integrations/galxe.ts
 *
 * Galxe API client. Confirmed against Galxe's own docs at time of writing:
 * production endpoint is a single GraphQL API at
 * https://graphigo-business.prd.galaxy.eco/query, authenticated with a
 * per-Space access token generated from the Galxe dashboard (Settings →
 * Accounts). See https://help.galxe.com/en/articles/8506982 and
 * https://docs.galxe.com/quest/graphql-api/claim-integrate.
 *
 * What's real here: the endpoint, the auth header shape, and the
 * transport (POST a GraphQL query/variables body, parse the JSON
 * response). What's NOT verified: the exact query field names for "list
 * participants who completed quest X" — that's Galxe's live GraphQL
 * schema, browsable from their Playground, and it wasn't practical to
 * confirm the exact shape without a real Space and access token. The
 * QUEST_COMPLETIONS_QUERY below is a reasonable placeholder in the
 * expected shape (campaign → participants → completed credentials) —
 * verify field names against the Playground schema before this runs
 * against a live campaign, and adjust the response parsing in
 * fetchQuestCompletions to match.
 */

import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

export interface GalxeQuestCompletion {
  wallet: string;
  questId: string;
  points: number;
}

const QUEST_COMPLETIONS_QUERY = /* GraphQL */ `
  query CampaignParticipants($campaignId: ID!, $cursor: String) {
    campaign(id: $campaignId) {
      participants(cursor: $cursor, first: 100) {
        list {
          address
          completedTasks {
            taskId
            points
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

/**
 * Pulls all quest completions for the configured campaign, across
 * pagination. Returns an empty array (and logs a warning) if Galxe env
 * vars aren't configured — this integration is optional at runtime, not
 * required for the rest of campaign to function.
 */
export async function fetchQuestCompletions(): Promise<GalxeQuestCompletion[]> {
  if (!campaignEnv.GALXE_ACCESS_TOKEN || !campaignEnv.GALXE_CAMPAIGN_ID) {
    logger.warn("Galxe sync skipped — GALXE_ACCESS_TOKEN or GALXE_CAMPAIGN_ID not set");
    return [];
  }

  const completions: GalxeQuestCompletion[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await fetch(campaignEnv.GALXE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": campaignEnv.GALXE_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: QUEST_COMPLETIONS_QUERY,
        variables: { campaignId: campaignEnv.GALXE_CAMPAIGN_ID, cursor },
      }),
    });

    if (!response.ok) {
      logger.error("Galxe API request failed", { status: response.status, statusText: response.statusText });
      break;
    }

    const body = (await response.json()) as {
      data?: {
        campaign?: {
          participants?: {
            list?: { address: string; completedTasks: { taskId: string; points: number }[] }[];
            pageInfo?: { endCursor?: string; hasNextPage?: boolean };
          };
        };
      };
      errors?: unknown[];
    };

    if (body.errors) {
      logger.error("Galxe API returned GraphQL errors", { errors: body.errors });
      break;
    }

    const participants = body.data?.campaign?.participants;
    for (const p of participants?.list ?? []) {
      for (const task of p.completedTasks) {
        completions.push({ wallet: p.address, questId: task.taskId, points: task.points });
      }
    }

    hasNextPage = participants?.pageInfo?.hasNextPage ?? false;
    cursor = participants?.pageInfo?.endCursor;
  }

  return completions;
}
