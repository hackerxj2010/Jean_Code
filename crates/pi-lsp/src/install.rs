//! Installing language servers and debug adapters that are missing.
//!
//! Everything lands under one directory Jean owns (`~/.jean/tools` by
//! default) — never a global `npm -g`, never the user's own virtualenv — so an
//! install cannot break a project and removing the directory undoes all of
//! it. Each ecosystem's own package manager does the work; a server that only
//! ships as a GitHub release is downloaded with `curl` and unpacked with the
//! system `tar` or `unzip`, which is what every platform Jean runs on has.
//!
//! `JEAN_DISABLE_LSP_DOWNLOAD=1` turns all of this off.

use crate::detect::{self, platform};
use crate::json::{self, JsonExt};
use crate::servers::{Asset, Install};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Where installs go, and how to run them.
#[derive(Clone, Debug)]
pub struct Toolbox {
    pub dir: PathBuf,
}

/// Whether automatic installs are switched off by the environment.
pub fn downloads_disabled() -> bool {
    ["JEAN_DISABLE_LSP_DOWNLOAD", "JEAN_DISABLE_DOWNLOADS"].iter().any(|key| {
        std::env::var(key).is_ok_and(|value| matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
    })
}

fn exe(name: &str) -> String {
    if cfg!(windows) && !name.contains('.') {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Glob with `*` only, case-insensitive: what asset patterns need.
pub fn matches_pattern(pattern: &str, name: &str) -> bool {
    fn go(pattern: &[u8], name: &[u8]) -> bool {
        match pattern.split_first() {
            None => name.is_empty(),
            Some((b'*', rest)) => (0..=name.len()).any(|skip| go(rest, &name[skip..])),
            Some((first, rest)) => name.first().is_some_and(|n| n.eq_ignore_ascii_case(first)) && go(rest, &name[1..]),
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

/// The asset rule for this platform, most specific first.
pub fn select_asset<'a>(assets: &'a [Asset], names: &[String]) -> Option<(&'a Asset, String)> {
    let (os, arch) = platform();
    let fits = |asset: &Asset| (asset.os == os || asset.os == "any") && (asset.arch == arch || asset.arch == "any");
    let mut rules: Vec<&Asset> = assets.iter().filter(|asset| fits(asset)).collect();
    // An exact arch beats `any`.
    rules.sort_by_key(|asset| (asset.os == "any") as u8 + (asset.arch == "any") as u8);
    for rule in rules {
        if let Some(name) = names.iter().find(|name| matches_pattern(&rule.pattern, name)) {
            return Some((rule, name.clone()));
        }
    }
    None
}

fn run(program: &Path, args: &[&str], cwd: Option<&Path>, env: &[(&str, String)]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|error| format!("{}: {error}", program.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: Vec<&str> = stderr.lines().chain(stdout.lines()).filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(8)..].join("\n");
    Err(format!("`{} {}` failed ({}):\n{tail}", program.display(), args.join(" "), output.status))
}

fn tool(name: &str) -> Result<PathBuf, String> {
    detect::which(name, &[], &[]).ok_or_else(|| format!("`{name}` is not installed"))
}

fn python() -> Result<PathBuf, String> {
    ["python3", "python", "py"].iter().find_map(|name| detect::which(name, &[], &[])).ok_or_else(|| "Python is not installed".to_string())
}

/// Searches `dir` for a file called `name` (or `name` with an executable
/// extension), since release archives nest their binaries under a versioned
/// folder whose name changes every release.
fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let wanted: Vec<String> = [name.to_string()].into_iter().chain(detect::executable_names(name)).collect();
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if wanted.iter().any(|w| entry.file_name().to_string_lossy().eq_ignore_ascii_case(w)) {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.sort();
    subdirs.iter().find_map(|sub| find_file(sub, name, depth - 1))
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

impl Toolbox {
    pub fn new(dir: impl Into<PathBuf>) -> Toolbox {
        Toolbox { dir: dir.into() }
    }

    /// `~/.jean/tools`, or `$JEAN_HOME/tools`.
    pub fn default_dir() -> PathBuf {
        if let Some(home) = std::env::var_os("JEAN_HOME") {
            return PathBuf::from(home).join("tools");
        }
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        home.join(".jean").join("tools")
    }

    fn venv(&self, id: &str) -> PathBuf {
        self.dir.join("pip").join(id)
    }

    fn venv_bin(&self, id: &str) -> PathBuf {
        self.venv(id).join(if cfg!(windows) { "Scripts" } else { "bin" })
    }

    /// The directories a toolbox install may have put binaries in, for a
    /// `which` that should also see them.
    pub fn bin_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.dir.join("npm").join("node_modules").join(".bin"),
            self.dir.join("go").join("bin"),
            self.dir.join("cargo").join("bin"),
            self.dir.join("gem").join("bin"),
            self.dir.join("dotnet"),
        ]
    }

    /// Where `install` put its binary, if it has already run.
    pub fn locate(&self, id: &str, install: &Install) -> Option<PathBuf> {
        let candidates: Vec<PathBuf> = match install {
            Install::Npm { bin, .. } => {
                let dir = self.dir.join("npm").join("node_modules").join(".bin");
                detect::executable_names(bin).into_iter().map(|name| dir.join(name)).collect()
            }
            Install::Go { bin, .. } => vec![self.dir.join("go").join("bin").join(exe(bin))],
            Install::Pip { bin, .. } => vec![self.venv_bin(id).join(exe(bin))],
            Install::Cargo { bin, .. } => vec![self.dir.join("cargo").join("bin").join(exe(bin))],
            Install::Gem { bin, .. } => {
                let dir = self.dir.join("gem").join("bin");
                vec![dir.join(format!("{bin}.bat")), dir.join(bin)]
            }
            Install::Dotnet { bin, .. } => vec![self.dir.join("dotnet").join(exe(bin))],
            Install::Github { .. } => {
                let marker = self.dir.join("github").join(id).join("current");
                fs::read_to_string(marker).ok().map(|path| PathBuf::from(path.trim())).into_iter().collect()
            }
            Install::Rustup { bin, .. } => {
                // `rustup which` knows where the component's binary is.
                let rustup = detect::which("rustup", &[], &[]);
                rustup
                    .and_then(|rustup| run(&rustup, &["which", bin], None, &[]).ok())
                    .map(|path| PathBuf::from(path.trim()))
                    .into_iter()
                    .collect()
            }
            Install::Manual { .. } => Vec::new(),
        };
        candidates.into_iter().find(|path| path.is_file())
    }

    /// Environment a binary from this toolbox needs to run — Ruby gems
    /// installed under their own `GEM_HOME` cannot find each other otherwise.
    pub fn runtime_env(&self, install: &Install) -> Vec<(String, String)> {
        match install {
            Install::Gem { .. } => {
                let home = self.dir.join("gem").to_string_lossy().to_string();
                vec![("GEM_HOME".into(), home.clone()), ("GEM_PATH".into(), home)]
            }
            _ => Vec::new(),
        }
    }

    /// Why this recipe cannot run here, if it cannot.
    pub fn cannot_install(&self, install: &Install) -> Option<String> {
        if downloads_disabled() {
            return Some("automatic installs are disabled (JEAN_DISABLE_LSP_DOWNLOAD)".into());
        }
        match install {
            Install::Manual { hint } => Some(format!("install it yourself: {hint}")),
            Install::Npm { .. } if detect::which("npm", &[], &[]).is_none() && detect::which("bun", &[], &[]).is_none() => {
                Some("needs Node.js (npm) or Bun".into())
            }
            Install::Pip { .. } if python().is_err() => Some("needs Python".into()),
            Install::Npm { .. } | Install::Pip { .. } => None,
            other => other
                .needs()
                .iter()
                .find(|needed| detect::which(needed, &[], &[]).is_none())
                .map(|needed| format!("needs `{needed}`")),
        }
    }

    /// Installs, returning the binary's path. `log` receives one line per
    /// step so the caller can say what happened.
    pub fn install(&self, id: &str, install: &Install, log: &mut Vec<String>) -> Result<PathBuf, String> {
        if let Some(reason) = self.cannot_install(install) {
            return Err(reason);
        }
        fs::create_dir_all(&self.dir).map_err(|error| format!("{}: {error}", self.dir.display()))?;

        match install {
            Install::Npm { packages, .. } => {
                let dir = self.dir.join("npm");
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let manifest = dir.join("package.json");
                if !manifest.exists() {
                    fs::write(&manifest, "{\"name\":\"jean-tools\",\"private\":true}\n").map_err(|e| e.to_string())?;
                }
                let dir_text = dir.to_string_lossy().to_string();
                let mut args: Vec<&str> = Vec::new();
                let program = if let Ok(npm) = tool("npm") {
                    args.extend(["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", &dir_text]);
                    npm
                } else {
                    args.extend(["add", "--cwd", &dir_text]);
                    tool("bun")?
                };
                args.extend(packages.iter().map(String::as_str));
                log.push(format!("{} {}", program.display(), args.join(" ")));
                run(&program, &args, Some(&dir), &[])?;
            }
            Install::Go { module, .. } => {
                let bin = self.dir.join("go").join("bin");
                fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
                log.push(format!("go install {module}"));
                run(&tool("go")?, &["install", module], None, &[("GOBIN", bin.to_string_lossy().to_string())])?;
            }
            Install::Pip { packages, .. } => {
                let venv = self.venv(id);
                if !self.venv_bin(id).exists() {
                    let python = python()?;
                    let mut args = Vec::new();
                    if python.file_stem().is_some_and(|stem| stem == "py") {
                        args.push("-3");
                    }
                    let venv_text = venv.to_string_lossy().to_string();
                    args.extend(["-m", "venv", venv_text.as_str()]);
                    log.push(format!("python -m venv {venv_text}"));
                    run(&python, &args, None, &[])?;
                }
                let python = self.venv_bin(id).join(exe("python"));
                let mut args = vec!["-m", "pip", "install", "--disable-pip-version-check", "--quiet"];
                args.extend(packages.iter().map(String::as_str));
                log.push(format!("pip install {}", packages.join(" ")));
                run(&python, &args, None, &[])?;
            }
            Install::Cargo { krate, .. } => {
                let root = self.dir.join("cargo").to_string_lossy().to_string();
                log.push(format!("cargo install {krate}"));
                let cargo = tool("cargo")?;
                // `--locked` when the crate allows it: its tested dependency set.
                if run(&cargo, &["install", "--locked", "--root", &root, krate], None, &[]).is_err() {
                    run(&cargo, &["install", "--root", &root, krate], None, &[])?;
                }
            }
            Install::Gem { gem, .. } => {
                let home = self.dir.join("gem");
                let bin = home.join("bin");
                fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
                let (home_text, bin_text) = (home.to_string_lossy().to_string(), bin.to_string_lossy().to_string());
                log.push(format!("gem install {gem}"));
                run(&tool("gem")?, &["install", "--no-document", "--install-dir", &home_text, "--bindir", &bin_text, gem], None, &[])?;
            }
            Install::Dotnet { tool: name, .. } => {
                let path = self.dir.join("dotnet").to_string_lossy().to_string();
                log.push(format!("dotnet tool install {name}"));
                run(&tool("dotnet")?, &["tool", "install", "--tool-path", &path, name], None, &[])?;
            }
            Install::Rustup { component, .. } => {
                log.push(format!("rustup component add {component}"));
                run(&tool("rustup")?, &["component", "add", component], None, &[])?;
            }
            Install::Github { repo, assets, bin } => return self.install_release(id, repo, assets, bin, log),
            Install::Manual { hint } => return Err(hint.clone()),
        }

        self.locate(id, install).ok_or_else(|| format!("the install finished but its binary was not where expected under {}", self.dir.display()))
    }

    fn install_release(&self, id: &str, repo: &str, assets: &[Asset], bin: &str, log: &mut Vec<String>) -> Result<PathBuf, String> {
        let curl = tool("curl")?;
        let api = format!("https://api.github.com/repos/{repo}/releases/latest");
        let mut args = vec!["-fsSL", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: jean-code"];
        let token = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")).ok();
        let header = token.as_ref().map(|token| format!("Authorization: Bearer {token}"));
        if let Some(header) = &header {
            args.extend(["-H", header.as_str()]);
        }
        args.push(&api);
        log.push(format!("GET {api}"));
        let release = json::parse(&run(&curl, &args, None, &[])?).map_err(|error| format!("{repo}: unreadable release JSON: {error}"))?;
        let tag = release.str_at("tag_name").unwrap_or("latest").to_string();
        let names: Vec<String> = release.at("assets").map(|a| a.items().to_vec()).unwrap_or_default().iter().filter_map(|a| a.str_at("name").map(String::from)).collect();
        let (_, asset_name) = select_asset(assets, &names).ok_or_else(|| {
            let (os, arch) = platform();
            format!("{repo} {tag} has no build for {os}/{arch} (assets: {})", names.join(", "))
        })?;
        let url = release
            .at("assets")
            .map(|a| a.items().to_vec())
            .unwrap_or_default()
            .iter()
            .find(|asset| asset.str_at("name") == Some(asset_name.as_str()))
            .and_then(|asset| asset.str_at("browser_download_url").map(String::from))
            .ok_or_else(|| format!("{asset_name}: no download URL"))?;

        let target = self.dir.join("github").join(id).join(tag.trim_start_matches('v'));
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let archive = target.join(&asset_name);
        log.push(format!("download {url}"));
        run(&curl, &["-fsSL", "-o", &archive.to_string_lossy(), &url], None, &[])?;
        self.unpack(&archive, &target, bin, log)?;

        let binary = find_file(&target, bin, 6).ok_or_else(|| format!("{asset_name} did not contain `{bin}`"))?;
        make_executable(&binary);
        fs::write(self.dir.join("github").join(id).join("current"), binary.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        Ok(binary)
    }

    fn unpack(&self, archive: &Path, into: &Path, bin: &str, log: &mut Vec<String>) -> Result<(), String> {
        let name = archive.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        let into_text = into.to_string_lossy().to_string();
        let archive_text = archive.to_string_lossy().to_string();

        if name.ends_with(".zip") || name.ends_with(".vsix") {
            log.push(format!("unzip {name}"));
            // Windows ships bsdtar, which reads zip; Git for Windows' GNU tar,
            // often first on PATH, does not — so the system one by full path.
            if cfg!(windows) {
                let system = std::env::var("SystemRoot").map(|root| PathBuf::from(root).join("System32").join("tar.exe")).unwrap_or_default();
                if system.is_file() {
                    return run(&system, &["-xf", &archive_text, "-C", &into_text], None, &[]).map(|_| ());
                }
            }
            if let Ok(unzip) = tool("unzip") {
                return run(&unzip, &["-o", "-q", &archive_text, "-d", &into_text], None, &[]).map(|_| ());
            }
            return run(&tool("tar")?, &["-xf", &archive_text, "-C", &into_text], None, &[]).map(|_| ());
        }
        if [".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tar"].iter().any(|ext| name.ends_with(ext)) {
            log.push(format!("untar {name}"));
            return run(&tool("tar")?, &["-xf", &archive_text, "-C", &into_text], None, &[]).map(|_| ());
        }
        if name.ends_with(".gz") {
            log.push(format!("gunzip {name}"));
            let output = into.join(exe(bin));
            let gzip = tool("gzip")?;
            let data = Command::new(gzip)
                .args(["-dc", &archive_text])
                .output()
                .map_err(|error| format!("gzip: {error}"))?;
            if !data.status.success() {
                return Err(format!("gzip could not decompress {name}"));
            }
            return fs::write(&output, data.stdout).map_err(|e| e.to_string());
        }
        // A bare binary: name it what the server is called.
        let output = into.join(exe(bin));
        if archive != output {
            fs::rename(archive, &output).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_versioned_asset_names() {
        assert!(matches_pattern("clangd-windows-*.zip", "clangd-windows-19.1.2.zip"));
        assert!(matches_pattern("lua-language-server-*-linux-x64.tar.gz", "lua-language-server-3.13.9-linux-x64.tar.gz"));
        assert!(!matches_pattern("clangd-mac-*.zip", "clangd-windows-19.zip"));
    }

    #[test]
    fn the_asset_for_this_platform_is_picked() {
        let assets = vec![
            Asset { os: "windows", arch: "x86_64", pattern: "tool-win-x64.zip".into() },
            Asset { os: "linux", arch: "x86_64", pattern: "tool-linux-x64.tar.gz".into() },
            Asset { os: "linux", arch: "aarch64", pattern: "tool-linux-arm64.tar.gz".into() },
            Asset { os: "macos", arch: "any", pattern: "tool-mac.tar.gz".into() },
            Asset { os: "any", arch: "any", pattern: "tool-universal.zip".into() },
        ];
        let names: Vec<String> =
            ["tool-win-x64.zip", "tool-linux-x64.tar.gz", "tool-linux-arm64.tar.gz", "tool-mac.tar.gz", "tool-universal.zip"].iter().map(|s| s.to_string()).collect();
        let (os, arch) = platform();
        let (_, chosen) = select_asset(&assets, &names).unwrap();
        let expected = match (os, arch) {
            ("windows", "x86_64") => "tool-win-x64.zip",
            ("linux", "x86_64") => "tool-linux-x64.tar.gz",
            ("linux", "aarch64") => "tool-linux-arm64.tar.gz",
            ("macos", _) => "tool-mac.tar.gz",
            _ => "tool-universal.zip",
        };
        assert_eq!(chosen, expected);
    }

    #[test]
    fn a_missing_recipe_explains_itself_and_downloads_can_be_disabled() {
        let toolbox = Toolbox::new(std::env::temp_dir().join("pi-lsp-toolbox-test"));
        let manual = Install::Manual { hint: "use ghcup".into() };
        assert!(toolbox.cannot_install(&manual).unwrap().contains("ghcup"));
        let mut log = Vec::new();
        assert!(toolbox.install("x", &manual, &mut log).is_err());
        assert!(toolbox.locate("x", &Install::Go { module: "m".into(), bin: "nope".into() }).is_none());
    }

    #[test]
    fn a_nested_binary_is_found_whatever_the_version_folder() {
        let dir = std::env::temp_dir().join(format!("pi-lsp-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("server-1.2.3/bin")).unwrap();
        let name = if cfg!(windows) { "srv.exe" } else { "srv" };
        fs::write(dir.join("server-1.2.3/bin").join(name), "").unwrap();
        assert_eq!(find_file(&dir, "srv", 4), Some(dir.join("server-1.2.3/bin").join(name)));
        fs::remove_dir_all(&dir).ok();
    }
}
