import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockEnv = vi.hoisted(() => ({
  GALXE_ACCESS_TOKEN: "test-token" as string | undefined,
  GALXE_CAMPAIGN_ID: "test-campaign" as string | undefined,
  GALXE_API_URL: "https://graphigo-business.prd.galaxy.eco/query",
}));

vi.mock("../../src/env.js", () => ({ campaignEnv: mockEnv }));

import { fetchQuestCompletions } from "../../src/integrations/galxe.js";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, statusText: ok ? "OK" : "Internal Server Error", json: async () => body };
}

function onePage(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      campaign: {
        participants: {
          list: [
            { address: "0xAAA", completedTasks: [{ taskId: "q1", points: 10 }] },
            { address: "0xBBB", completedTasks: [{ taskId: "q1", points: 10 }, { taskId: "q2", points: 5 }] },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    ...overrides,
  };
}

describe("fetchQuestCompletions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockEnv.GALXE_ACCESS_TOKEN = "test-token";
    mockEnv.GALXE_CAMPAIGN_ID = "test-campaign";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // logger writes warn/error to stderr via console.error
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips the request entirely and returns [] when the access token isn't configured", async () => {
    mockEnv.GALXE_ACCESS_TOKEN = undefined;
    const result = await fetchQuestCompletions();

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the request entirely and returns [] when the campaign id isn't configured", async () => {
    mockEnv.GALXE_CAMPAIGN_ID = undefined;
    const result = await fetchQuestCompletions();

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flattens participants × completedTasks into one entry per (wallet, quest)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(onePage()));

    const result = await fetchQuestCompletions();

    expect(result).toEqual([
      { wallet: "0xAAA", questId: "q1", points: 10 },
      { wallet: "0xBBB", questId: "q1", points: 10 },
      { wallet: "0xBBB", questId: "q2", points: 5 },
    ]);
  });

  it("sends the access token as the access-token header and the campaign id as a query variable", async () => {
    fetchMock.mockResolvedValue(jsonResponse(onePage()));

    await fetchQuestCompletions();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(mockEnv.GALXE_API_URL);
    expect(init.headers["access-token"]).toBe("test-token");
    const body = JSON.parse(init.body);
    expect(body.variables.campaignId).toBe("test-campaign");
  });

  it("follows pagination — makes a second request with the cursor from the first page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            campaign: {
              participants: {
                list: [{ address: "0xAAA", completedTasks: [{ taskId: "q1", points: 10 }] }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            campaign: {
              participants: {
                list: [{ address: "0xBBB", completedTasks: [{ taskId: "q1", points: 10 }] }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );

    const result = await fetchQuestCompletions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.variables.cursor).toBe("cursor-1");
    expect(result).toHaveLength(2);
  });

  it("stops and returns what it has so far when a page request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            campaign: {
              participants: {
                list: [{ address: "0xAAA", completedTasks: [{ taskId: "q1", points: 10 }] }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(null, false)); // second page fails

    const result = await fetchQuestCompletions();

    expect(result).toHaveLength(1); // keeps the first page's results rather than discarding everything
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops on a GraphQL errors response even with a 200 status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "field not found" }] }));

    const result = await fetchQuestCompletions();

    expect(result).toEqual([]);
  });

  it("returns [] without crashing on an empty or malformed response body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const result = await fetchQuestCompletions();

    expect(result).toEqual([]);
  });

  it("handles a participant with no completed tasks without adding a stray entry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          campaign: {
            participants: {
              list: [{ address: "0xAAA", completedTasks: [] }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );

    const result = await fetchQuestCompletions();

    expect(result).toEqual([]);
  });
});
