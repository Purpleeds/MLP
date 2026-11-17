// Platform adapter: real Tauri APIs inside the app, harmless no-ops in mock mode (plain browser).
export type ResizeDirection = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export const platform = {
  async show() {
    if (isTauri()) await (await win()).show();
  },
  async startDragging() {
    if (isTauri()) await (await win()).startDragging();
  },
  async startResize(dir: ResizeDirection) {
    if (isTauri()) await (await win()).startResizeDragging(dir);
  },
  async hide() {
    if (isTauri()) await (await win()).hide();
  },
  async isVisible(): Promise<boolean> {
    return isTauri() ? (await win()).isVisible() : true;
  },
  /** Logical inner size of the window. */
  async size(): Promise<{ w: number; h: number }> {
    if (!isTauri()) return { w: window.innerWidth, h: window.innerHeight };
    const w = await win();
    const sf = await w.scaleFactor();
    const s = await w.innerSize();
    return { w: Math.round(s.width / sf), h: Math.round(s.height / sf) };
  },
  /** Resize keeping the corner nearest the screen edges fixed (e.g. stays docked near the clock). */
  async resizeAnchored(lw: number, lh: number) {
    if (!isTauri()) return;
    const { currentMonitor, PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/window");
    const w = await win();
    const sf = await w.scaleFactor();
    const pos = await w.outerPosition();
    const size = await w.outerSize();
    const nw = Math.round(lw * sf);
    const nh = Math.round(lh * sf);
    let x = pos.x;
    let y = pos.y;
    const mon = await currentMonitor();
    if (mon) {
      const a = mon.workArea;
      if (pos.x + size.width / 2 > a.position.x + a.size.width / 2) x = pos.x + size.width - nw;
      if (pos.y + size.height / 2 > a.position.y + a.size.height / 2) y = pos.y + size.height - nh;
      x = Math.max(a.position.x, Math.min(x, a.position.x + a.size.width - nw));
      y = Math.max(a.position.y, Math.min(y, a.position.y + a.size.height - nh));
    }
    await w.setSize(new PhysicalSize(nw, nh));
    await w.setPosition(new PhysicalPosition(x, y));
  },
  /** Move the window to a corner of its monitor's work area. */
  async moveToCorner(corner: "tl" | "tr" | "bl" | "br") {
    if (!isTauri()) return;
    const { currentMonitor, PhysicalPosition } = await import("@tauri-apps/api/window");
    const w = await win();
    const mon = await currentMonitor();
    if (!mon) return;
    const a = mon.workArea;
    const size = await w.outerSize();
    const m = Math.round(16 * mon.scaleFactor);
    const x = corner.endsWith("l") ? a.position.x + m : a.position.x + a.size.width - size.width - m;
    const y = corner.startsWith("t") ? a.position.y + m : a.position.y + a.size.height - size.height - m;
    await w.setPosition(new PhysicalPosition(x, y));
  },
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
    if (!isTauri()) return undefined;
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  },
  /** Log to the app's stdout (visible in `tauri dev`). */
  log(msg: string) {
    if (isTauri()) void this.invoke("log_message", { msg }).catch(() => undefined);
    else console.info(msg);
  },
  /** Broadcast an event to all app windows. */
  async emit(event: string, payload?: unknown) {
    if (!isTauri()) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  },
  async onResized(cb: () => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    return (await win()).onResized(() => cb());
  },
  async setAlwaysOnTop(on: boolean) {
    if (isTauri()) await (await win()).setAlwaysOnTop(on);
  },
  async setSkipTaskbar(skip: boolean) {
    if (isTauri()) await (await win()).setSkipTaskbar(skip);
  },
  async setClickThrough(locked: boolean) {
    if (!isTauri()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_click_through", { locked });
  },
  /** Subscribe to a backend event; returns an unsubscribe function. */
  async on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, (e) => cb(e.payload));
  },
};
