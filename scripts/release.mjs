// Release build with update artifacts (Upgrade 16):
//   node scripts/release.mjs <owner>/<repo> ["release notes"]
// Needs the updater private key: TAURI_SIGNING_PRIVATE_KEY (or the file at ~/.tauri/mlp.key) and,
// if the key has one, TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Builds the signed installer and writes
// latest.json next to it — upload both (plus the .sig) to a GitHub release tagged v<version>.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [repo, notes = ""] = process.argv.slice(2);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("usage: node scripts/release.mjs <owner>/<repo> [notes]");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = join(homedir(), ".tauri", "mlp.key");
  if (!existsSync(keyFile)) throw new Error(`No updater key: set TAURI_SIGNING_PRIVATE_KEY or put it at ${keyFile}`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8");
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

execSync(`npx tauri build --config "{\\"bundle\\":{\\"createUpdaterArtifacts\\":true}}"`, { cwd: root, env, stdio: "inherit" });

const dir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const setup = readdirSync(dir).find((f) => f.endsWith("-setup.exe") && f.includes(version));
if (!setup || !existsSync(join(dir, `${setup}.sig`))) throw new Error("signed installer not found");
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(dir, `${setup}.sig`), "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(setup)}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2));
console.log(`\nUpload to a GitHub release tagged v${version}:\n  ${join(dir, setup)}\n  ${join(dir, `${setup}.sig`)}\n  ${join(dir, "latest.json")}`);
console.log(`Update feed for Settings → General: https://github.com/${repo}/releases/latest/download/latest.json`);
