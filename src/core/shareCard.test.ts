import { describe, expect, it } from "vitest";
import { wrapText } from "./shareCard";

const measure = (s: string) => s.length * 10;

describe("share card", () => {
  it("wraps words to the width", () => {
    expect(wrapText(measure, "Folded up the evening into paper satellites", 200)).toEqual(["Folded up the", "evening into paper", "satellites"]);
  });
  it("breaks CJK text anywhere", () => {
    expect(wrapText(measure, "夜空に光る紙の星を見上げて", 50)).toEqual(["夜空に光る", "紙の星を見", "上げて"]);
  });
});
