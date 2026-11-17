// Runs before bundling (tauri.conf build.beforeBundleCommand): copies the DLLs the AI build loads at
// start-up into src-tauri/redist/, which the NSIS hooks install next to mlp.exe:
//  - DirectML.dll (ONNX Runtime's DirectML provider; copied into target/release by the ort crate)
//  - the MSVC C++ runtime (ONNX Runtime needs msvcp140*.dll; app-local deployment is allowed)
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("[redist] not Windows — nothing to copy");
  process.exit(0);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const out = join(root, "redist");
mkdirSync(out, { recursive: true });

// CARGO_TARGET_DIR (shared build folder) wins over the project's own target folder.
const dml = join(process.env.CARGO_TARGET_DIR || join(root, "target"), "release", "DirectML.dll");
if (!existsSync(dml)) throw new Error(`DirectML.dll not found at ${dml} (build with the onnx feature first)`);
copyFileSync(dml, join(out, "DirectML.dll"));

// The CRT folder is named after the toolset: Microsoft.VC143.CRT (VS 2022), Microsoft.VC145.CRT (VS 2026), ...
// -> take whichever one this redist version has. The DLL names stay msvcp140*.dll / vcruntime140*.dll.
function crtIn(x64Dir) {
  const crt = existsSync(x64Dir) ? readdirSync(x64Dir).filter((d) => /^Microsoft\.VC\d+\.CRT$/i.test(d)).sort().pop() : undefined;
  return crt && existsSync(join(x64Dir, crt, "msvcp140.dll")) ? join(x64Dir, crt) : undefined;
}
const byVersion = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
function vcRedistDir() {
  const fromEnv = process.env.VCToolsRedistDir && crtIn(join(process.env.VCToolsRedistDir, "x64"));
  if (fromEnv) return fromEnv;
  const vswhere = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
  const vs = existsSync(vswhere) ? execFileSync(vswhere, ["-latest", "-property", "installationPath"], { encoding: "utf8" }).trim() : "";
  const base = join(vs, "VC", "Redist", "MSVC");
  const vers = existsSync(base) ? readdirSync(base).filter((d) => /^\d+\./.test(d)).sort(byVersion).reverse() : [];
  for (const v of vers) {
    const dir = crtIn(join(base, v, "x64"));
    if (dir) return dir;
  }
  throw new Error(`Visual C++ redistributable files not found under ${base} (install the VS C++ build tools)`);
}
const crt = vcRedistDir();
for (const f of ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) copyFileSync(join(crt, f), join(out, f));
console.log(`[redist] DirectML + MSVC runtime → ${out}`);
