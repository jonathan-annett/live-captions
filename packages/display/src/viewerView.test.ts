import { describe, expect, it } from "vitest";
import { connectionView, isNearBottom } from "./viewerView.js";

describe("isNearBottom", () => {
  it("is true at the exact bottom", () => {
    expect(isNearBottom(900, 1000, 100)).toBe(true);
  });

  it("is true within the threshold", () => {
    // 1000 - (850 + 100) = 50 <= 80
    expect(isNearBottom(850, 1000, 100)).toBe(true);
  });

  it("is false when scrolled up beyond the threshold", () => {
    // 1000 - (700 + 100) = 200 > 80
    expect(isNearBottom(700, 1000, 100)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isNearBottom(700, 1000, 100, 250)).toBe(true);
  });
});

describe("connectionView", () => {
  it("marks only the open state as live", () => {
    expect(connectionView("open")).toEqual({ label: "Live", live: true });
    expect(connectionView("connecting").live).toBe(false);
    expect(connectionView("reconnecting").live).toBe(false);
    expect(connectionView("closed").live).toBe(false);
  });

  it("labels each state", () => {
    expect(connectionView("connecting").label).toBe("Connecting…");
    expect(connectionView("reconnecting").label).toBe("Reconnecting…");
    expect(connectionView("closed").label).toBe("Disconnected");
  });
});
