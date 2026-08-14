import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/logger.js";

// Identical to apps/keeper/test/unit/logger.test.ts, since the module
// itself is an intentional copy — kept here so campaign has its own
// regression coverage independent of keeper's.
describe("logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info writes a single valid JSON line to stdout", () => {
    logger.info("test", { wallet: "0xabc" });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.msg).toBe("test");
    expect(output.wallet).toBe("0xabc");
  });

  it("error and warn write to stderr, not stdout", () => {
    logger.error("boom");
    logger.warn("careful");
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
