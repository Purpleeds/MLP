import { describe, expect, it } from "vitest";
import { sameTrack } from "./spotify";

describe("spotify", () => {
  it("matches the player's track with the Web API's", () => {
    const t = { title: "Never Gonna Give You Up", artists: ["Rick Astley"] };
    expect(sameTrack({ title: "Never Gonna Give You Up", artist: "Rick Astley" }, t)).toBe(true);
    expect(sameTrack({ title: "Never Gonna Give You Up - Remastered 2022", artist: "Rick Astley" }, t)).toBe(true);
    expect(sameTrack({ title: "Together Forever", artist: "Rick Astley" }, t)).toBe(false);
    expect(sameTrack({ title: "Never Gonna Give You Up", artist: "Someone Else" }, t)).toBe(false);
    expect(sameTrack({ title: "APT.", artist: "ROSÉ, Bruno Mars" }, { title: "APT.", artists: ["ROSÉ", "Bruno Mars"] })).toBe(true);
  });
});
