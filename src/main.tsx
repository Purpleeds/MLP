import React from "react";
import ReactDOM from "react-dom/client";
import { initSettings } from "./core/settings/store";
import { platform } from "./core/platform";
import { logUncaughtErrors, reportUiError } from "./core/uiErrors";
import "@fontsource-variable/inter";

const isSettings = new URLSearchParams(location.search).get("window") === "settings";
if (isSettings) document.title = "MLP Settings";
const windowName = isSettings ? "settings" : "main";
logUncaughtErrors(windowName);

void initSettings().finally(async () => {
  const Root = isSettings ? (await import("./settings/SettingsApp")).default : (await import("./app/App")).default;
  // Errors no boundary caught unmount everything: keep a record of them (ui-errors.json).
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
    onUncaughtError: (error, info) => reportUiError(`${windowName}/root`, error, info.componentStack),
  }).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
  // Show the (initially hidden) main window after the first paint (no white flash),
  // unless autostart launched us hidden — then it appears when music plays.
  if (!isSettings) {
    const hidden = await platform.invoke<boolean>("launched_hidden").catch(() => false);
    (window as { __mlpHidden?: boolean }).__mlpHidden = !!hidden;
    if (!hidden) requestAnimationFrame(() => requestAnimationFrame(() => void platform.show()));
  }
});
