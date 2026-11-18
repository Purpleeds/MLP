// Full offline package: the NSIS installer plus every AI download, so nothing is downloaded on first use.
//   npm run build:full            (= tauri build, then this script)
//   node scripts/build-full.mjs [--zip]   (after a release build)
// NSIS can't hold more than 2 GB in one setup.exe, so the AI files go in an "ai-data" folder next to it:
//   bundle/full/MLP_<ver>_x64-full/
//     MLP_<ver>_x64-setup.exe
//     ai-data/runtime/<id>/...   (unpacked zips: Whisper engines, Japanese dictionary)
//     ai-data/models/<id>.bin
// The installer copies ai-data to <install folder>\ai (src-tauri/windows/hooks.nsh); the app looks there
// before downloading (src-tauri/src/ai.rs). The asset list (URLs + SHA-256) is read from ai.rs CATALOG.
// Downloads are cached in <target>/ai-cache and checked against the pinned hashes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const LIMIT_BYTES = 15e9;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "src-tauri");
const target = process.env.CARGO_TARGET_DIR || join(tauri, "target");
const version = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8")).version;
const zip = process.argv.includes("--zip");

/** Catalog entries from ai.rs (one source of truth for URLs and hashes). */
function catalog() {
  const src = readFileSync(join(tauri, "src", "ai.rs"), "utf8");
  const block = src.slice(src.indexOf("pub const CATALOG"), src.indexOf("];", src.indexOf("pub const CATALOG")));
  const field = (body, k) => body.match(new RegExp(`${k}:\\s*"([^"]*)"`))?.[1];
  const list = [...block.matchAll(/Asset\s*\{([\s\S]*?)\n\s*\},/g)].map(([, b]) => ({
    id: field(b, "id"),
    kind: field(b, "kind"),
    url: field(b, "url"),
    sha256: field(b, "sha256"),
  }));
  if (!list.length || list.some((a) => !a.id || !a.kind || !a.url || !/^[0-9a-f]{64}$/.test(a.sha256 ?? ""))) throw new Error("couldn't read CATALOG from ai.rs");
  return list;
}

async function sha256(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function fetchTo(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": `MLP-build/${version}` } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`download failed: ${url}: ${e.message}`);
      console.log(`  retrying (${e.message})`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

/** A verified copy of the asset's download in the cache (reuses the app's own model files when they match). */
async function cached(a) {
  const dir = join(target, "ai-cache");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${a.id}${a.kind === "runtime" ? ".zip" : ".bin"}`);
  if (existsSync(file) && (await sha256(file)) === a.sha256) return file;
  const appCopy = process.env.APPDATA && join(process.env.APPDATA, "com.mlp.lyrics", "ai", "models", `${a.id}.bin`);
  if (a.kind === "model" && appCopy && existsSync(appCopy) && (await sha256(appCopy)) === a.sha256) {
    console.log(`  ${a.id}: from the app's own copy`);
    copyFileSync(appCopy, file);
    return file;
  }
  console.log(`  ${a.id}: downloading ${a.url}`);
  const part = `${file}.part`;
  await fetchTo(a.url, part);
  const got = await sha256(part);
  if (got !== a.sha256) throw new Error(`${a.id}: checksum mismatch (${got})`);
  renameSync(part, file);
  return file;
}

function dirSize(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((s, f) => s + dirSize(join(p, f)), 0);
}

// --prefetch: only fill the download cache (can run while the app builds).
if (process.argv.includes("--prefetch")) {
  for (const a of catalog()) await cached(a);
  console.log("[full] download cache ready");
  process.exit(0);
}

const out = join(target, "release", "bundle", "full", `MLP_${version}_x64-full`);
rmSync(out, { recursive: true, force: true });
const data = join(out, "ai-data");
mkdirSync(join(data, "models"), { recursive: true });
mkdirSync(join(data, "runtime"), { recursive: true });

console.log("[full] AI files");
for (const a of catalog()) {
  const file = await cached(a);
  if (a.kind === "runtime") {
    const dest = join(data, "runtime", a.id);
    mkdirSync(dest, { recursive: true });
    // Windows' own tar (bsdtar) unpacks zip files; Git's GNU tar doesn't.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "bsdtar";
    execFileSync(tar, ["-xf", file, "-C", dest], { stdio: "inherit" });
  } else {
    copyFileSync(file, join(data, "models", `${a.id}.bin`));
  }
}
const nsis = join(target, "release", "bundle", "nsis");
const setup = existsSync(nsis) && readdirSync(nsis).find((f) => f.endsWith("-setup.exe") && f.includes(version));
if (!setup) throw new Error(`no MLP ${version} installer in ${nsis} (run npm run tauri build first)`);
copyFileSync(join(nsis, setup), join(out, setup));
writeFileSync(
  join(out, "README.txt"),
  `MLP ${version} - full package\r\n\r\nRun ${setup}. It installs MLP and copies the AI models from the ai-data folder\r\n(Whisper, vocal isolation, auto-sync, Japanese dictionary), so nothing is downloaded on first use.\r\nKeep ai-data next to the installer.\r\n\r\nLyric translation still needs the internet (it uses the MyMemory online service).\r\n`,
);

const total = dirSize(out);
console.log(`[full] ${out}\n[full] ${(total / 1e9).toFixed(2)} GB (AI data ${(dirSize(data) / 1e9).toFixed(2)} GB)`);
if (total > LIMIT_BYTES) throw new Error(`full package is ${(total / 1e9).toFixed(1)} GB, over the 15 GB limit`);

if (zip) {
  const zipFile = `${out}.zip`;
  rmSync(zipFile, { force: true });
  // Store only: the models don't compress, and a stored zip unpacks fast in Explorer.
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-c", "--options", "zip:compression=store", "-f", zipFile, "-C", dirname(out), `MLP_${version}_x64-full`], { stdio: "inherit" });
  console.log(`[full] ${zipFile} ${(statSync(zipFile).size / 1e9).toFixed(2)} GB`);
}
