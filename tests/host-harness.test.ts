import { describe, expect, test } from "bun:test";
import { isSupportedHostVersion } from "./host-harness";

describe("TodoFoundation host version validator", () => {
  test("accepts the exact supported native version", () => {
    const version = "opencode v2.0.26";
    const accepted = isSupportedHostVersion(version);
    expect(accepted).toBe(true);
  });

  test.each(["opencode v2.0.15", "opencode v2.0.27", "opencode v2.0.26-dev", "2.0.26", ""])(
    "rejects unsupported version %j",
    (version) => {
      const accepted = isSupportedHostVersion(version);
      expect(accepted).toBe(false);
    },
  );
});
