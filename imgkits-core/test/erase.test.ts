import { describe, expect, it, vi } from "vitest";
import { HIDDEN_TOOLS, VISIBLE_TOOLS } from "../src/config";
import { ERASE_OBJECT_LISTED, eraseObject } from "../src/tools/erase-object";
import { testCtx } from "./helpers";

describe("erase_object", () => {
  it("is hidden, not billed, and never calls upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(ERASE_OBJECT_LISTED).toBe(false);
    expect(VISIBLE_TOOLS).not.toContain("erase_object");
    expect(HIDDEN_TOOLS).toEqual(["erase_object"]);
    await expect(eraseObject(testCtx)).rejects.toMatchObject({ code: "tool_not_ready" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
