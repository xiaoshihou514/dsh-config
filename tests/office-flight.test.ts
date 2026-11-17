import { describe, expect, it } from "vitest";
import { FLIGHT_FRESH_MS, FLIGHT_MAX, shouldFly } from "../src/office-scene/index.ts";

describe("信件动画只演实时消息", () => {
  const now = 1_800_000_000_000;
  it("刚发出的、场景在播、未满额才飞", () => {
    expect(shouldFly(now - 2000, now, 0, true)).toBe(true);
  });
  it("旧消息（轮询隔了一阵才拿到）不补放", () => {
    expect(shouldFly(now - FLIGHT_FRESH_MS - 1, now, 0, true)).toBe(false);
  });
  it("暂停 / 后台期间到的不飞", () => {
    expect(shouldFly(now - 1000, now, 0, false)).toBe(false);
  });
  it("在飞的满额时略过，不排队", () => {
    expect(shouldFly(now - 1000, now, FLIGHT_MAX, true)).toBe(false);
    expect(shouldFly(now - 1000, now, FLIGHT_MAX - 1, true)).toBe(true);
  });
});
