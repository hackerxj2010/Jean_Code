//! Building what a native debugger runs.
//!
//! CodeLLDB, lldb-dap, and GDB debug a binary, while an agent names the
//! source it wants to stop in: `src/main.rs:7`. So a source file (or a
//! `Cargo.toml`, or a crate directory) is built first — with debug info, no
//! optimisation — and the binary it produced is what gets launched. A build
//! that fails answers with the compiler's own errors, which is what the
//! caller has to fix before there is anything to debug.

use pi_lsp::json::{self, JsonExt};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Whether `program` is something to build rather than to run.
pub fn needs_build(program: &Path) -> bool {
    if program.is_dir() {
        return program.join("Cargo.toml").is_file();
    }
    let name = program.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let extension = program.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    name == "Cargo.toml" || matches!(extension.as_str(), "rs" | "c" | "cc" | "cpp" | "cxx")
}

/// Builds `program` and returns the binary to debug.
pub fn build(program: &Path) -> Result<PathBuf, String> {
    let extension = program.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    if program.is_dir() || extension == "rs" || program.file_name().is_some_and(|n| n == "Cargo.toml") {
        cargo(program)
    } else {
        single_file(program, &extension)
    }
}

/// The manifest that owns `path`: the file itself, the directory's, or the
/// nearest one above a source file.
fn manifest_for(path: &Path) -> Option<PathBuf> {
    if path.file_name().is_some_and(|n| n == "Cargo.toml") {
        return Some(path.to_path_buf());
    }
    let start = if path.is_dir() { path } else { path.parent()? };
    start.ancestors().map(|dir| dir.join("Cargo.toml")).find(|manifest| manifest.is_file())
}

fn cargo(program: &Path) -> Result<PathBuf, String> {
    let manifest = manifest_for(program).ok_or_else(|| format!("{} is not in a Cargo project: there is no Cargo.toml above it", program.display()))?;
    let mut command = Command::new("cargo");
    command.args(["build", "--message-format=json-render-diagnostics", "--manifest-path"]).arg(&manifest);
    // `src/bin/tool.rs` is the binary `tool`.
    if program.parent().and_then(Path::file_name).is_some_and(|n| n == "bin") {
        if let Some(stem) = program.file_stem() {
            command.arg("--bin").arg(stem);
        }
    }
    let output = command.output().map_err(|error| format!("could not run cargo: {error}"))?;
    let artifacts: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| json::parse(line).ok())
        .filter(|message| message.str_at("reason") == Some("compiler-artifact") && message.str_at("executable").is_some())
        .collect();
    if !output.status.success() {
        return Err(format!("cargo build failed:\n{}", tail(&String::from_utf8_lossy(&output.stderr), 4000)));
    }
    let same = |a: &str| Path::new(a).canonicalize().ok() == program.canonicalize().ok();
    let manifest_text = manifest.to_string_lossy().to_string();
    let chosen = artifacts
        .iter()
        .find(|a| a.str_at("target.src_path").is_some_and(same))
        .or_else(|| {
            artifacts.iter().find(|a| {
                a.str_at("manifest_path").is_some_and(|m| Path::new(m) == Path::new(&manifest_text))
                    && a.at("target.kind").is_some_and(|k| k.items().iter().any(|kind| kind.as_str() == Some("bin")))
            })
        })
        .or_else(|| artifacts.last())
        .and_then(|a| a.str_at("executable"))
        .ok_or_else(|| format!("cargo built no binary from {}: debug a crate with a `main`", manifest.display()))?;
    Ok(PathBuf::from(chosen))
}

/// One C or C++ file, compiled on its own by the first compiler found.
fn single_file(source: &Path, extension: &str) -> Result<PathBuf, String> {
    let cpp = extension != "c";
    let compilers: &[&str] = if cpp { &["clang++", "g++", "c++"] } else { &["clang", "gcc", "cc"] };
    let binary = std::env::temp_dir()
        .join("jean-debug")
        .join(format!("{}{}", source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "program".into()), std::env::consts::EXE_SUFFIX));
    let _ = std::fs::create_dir_all(binary.parent().unwrap_or(Path::new(".")));
    for compiler in compilers {
        let mut command = Command::new(compiler);
        command.arg("-g").arg("-O0").arg(source).arg("-o").arg(&binary);
        match command.output() {
            Ok(output) if output.status.success() => return Ok(binary),
            Ok(output) => return Err(format!("{compiler} failed:\n{}", tail(&String::from_utf8_lossy(&output.stderr), 4000))),
            Err(_) => continue,
        }
    }
    // MSVC, when its environment is set up (a Developer prompt).
    if cfg!(windows) && std::env::var_os("INCLUDE").is_some() {
        let mut command = Command::new("cl");
        command.args(["/nologo", "/Zi", "/Od", "/EHsc"]).arg(source).arg(format!("/Fe:{}", binary.display()));
        command.current_dir(binary.parent().unwrap_or(Path::new(".")));
        if let Ok(output) = command.output() {
            return if output.status.success() {
                Ok(binary)
            } else {
                Err(format!("cl failed:\n{}", tail(&String::from_utf8_lossy(&output.stdout), 4000)))
            };
        }
    }
    Err(format!(
        "no C{} compiler found ({}); build {} with debug info and pass the binary as `program`",
        if cpp { "++" } else { "" },
        compilers.join(", "),
        source.display()
    ))
}

fn tail(text: &str, max: usize) -> String {
    let text = text.trim_end();
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("...{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_and_manifests_are_built_binaries_are_not() {
        assert!(needs_build(Path::new("src/main.rs")));
        assert!(needs_build(Path::new("Cargo.toml")));
        assert!(needs_build(Path::new("hello.cpp")));
        assert!(!needs_build(Path::new("target/debug/app.exe")));
        assert!(!needs_build(Path::new("target/debug/app")));
        assert!(!needs_build(Path::new("main.py")));
    }

    #[test]
    fn a_source_file_finds_the_manifest_above_it() {
        let root = std::env::temp_dir().join(format!("pi-dap-build-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src/bin")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        assert_eq!(manifest_for(&root.join("src/bin/tool.rs")), Some(root.join("Cargo.toml")));
        assert_eq!(manifest_for(&root), Some(root.join("Cargo.toml")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
