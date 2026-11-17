import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./schema";
import { gpuKind, withLightMode } from "./light";

describe("light mode", () => {
  it("tells integrated from dedicated graphics by the renderer name", () => {
    expect(gpuKind("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("integrated");
    expect(gpuKind("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("integrated");
    expect(gpuKind("ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("integrated");
    expect(gpuKind("ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("integrated");
    expect(gpuKind("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("integrated");
    expect(gpuKind("ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("discrete");
    expect(gpuKind("ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("discrete");
    expect(gpuKind("ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("discrete");
    expect(gpuKind("")).toBeNull();
  });

  it("switches the heavy parts off and back to the defaults", () => {
    const on = withLightMode(DEFAULT_SETTINGS, true);
    expect(on.app.lightMode).toBe(true);
    expect([on.ai.isolateVocals, on.ai.lyrics, on.ai.threads, on.background.type, on.lyrics.blur, on.lyrics.fps]).toEqual([false, false, 2, "art", false, 30]);
    expect(on.ai.autoSync).toBe(true); // the most useful AI part stays
    const off = withLightMode(on, false);
    expect(off).toEqual({ ...DEFAULT_SETTINGS, app: { ...DEFAULT_SETTINGS.app, lightMode: false } });
  });
});
