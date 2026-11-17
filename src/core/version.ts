// App version and identity used for outside services (LRCLIB asks clients to identify themselves:
// app name + version only, nothing about the user) and the update feed.
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;
export const CLIENT_ID = `MLP/${APP_VERSION} (floating lyrics for Windows)`;

/** Official release feed (GitHub Releases); Settings → General → Update feed overrides it. */
export const UPDATE_FEED = "https://github.com/Purpleeds/MLP/releases/latest/download/latest.json";
export const updateFeed = (custom: string) => custom.trim() || UPDATE_FEED;
