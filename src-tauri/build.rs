fn main() {
    // macOS: ONNX Runtime's CoreML code calls `__isPlatformVersionAtLeast` (behind `@available`), which
    // lives in clang's runtime library; Rust links with -nodefaultlibs, so add libclang_rt.osx.a.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let dir = std::process::Command::new("clang")
            .arg("--print-runtime-dir")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|d| std::path::Path::new(d).join("libclang_rt.osx.a").exists());
        if let Some(dir) = dir {
            println!("cargo:rustc-link-search=native={dir}");
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
        } else {
            println!("cargo:warning=libclang_rt.osx.a not found (clang --print-runtime-dir); linking ONNX Runtime may fail");
        }
    }
    tauri_build::build()
}
