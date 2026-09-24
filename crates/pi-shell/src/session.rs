//! A persistent shell session and the policy that gates what it may run.
//!
//! The point of a session is that `export VAR=v` in one tool call leaves `$VAR`
//! set for the next. Without it, every agent command starts from a blank shell,
//! and the agent compensates by re-exporting the world in a single enormous
//! one-liner — which is both fragile and unreadable in a transcript.

use pi_builtins::Output;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Session {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub variables: HashMap<String, String>,
    pub aliases: HashMap<String, String>,
    pub positional: Vec<String>,
    pub last_status: i32,
    /// Set when `exit` ran, with the code it asked for.
    pub exited: Option<i32>,
    pub policy: Policy,
    /// Directories `cd -` walks back through.
    history: Vec<PathBuf>,
}

impl Session {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| cwd.clone());

        // The session starts from the real environment: a shell that cannot see
        // PATH cannot run anything, and one that cannot see the API key the
        // user exported is useless to the agent.
        let variables: HashMap<String, String> = std::env::vars().collect();

        Session {
            cwd,
            home,
            variables,
            aliases: HashMap::new(),
            positional: Vec::new(),
            last_status: 0,
            exited: None,
            policy: Policy::default(),
            history: Vec::new(),
        }
    }

    /// Resolves a path against the session's cwd.
    pub fn resolve(&self, path: &str) -> PathBuf {
        let candidate = PathBuf::from(path);
        if candidate.is_absolute() {
            candidate
        } else {
            self.cwd.join(candidate)
        }
    }

    pub fn cd(&mut self, target: Option<&str>) -> Output {
        let destination = match target {
            None | Some("~") => self.home.clone(),
            Some("-") => match self.history.pop() {
                Some(previous) => previous,
                None => return Output::fail("cd: no previous directory", 1),
            },
            Some(path) => self.resolve(path),
        };

        let canonical = match std::fs::canonicalize(&destination) {
            Ok(canonical) => canonical,
            Err(error) => {
                return Output::fail(format!("cd: {}: {error}", destination.display()), 1)
            }
        };

        if !canonical.is_dir() {
            return Output::fail(format!("cd: {}: not a directory", canonical.display()), 1);
        }

        if let Some(reason) = self.policy.refuse_directory(&canonical) {
            return Output::fail(format!("cd: {reason}"), 1);
        }

        self.history.push(std::mem::replace(&mut self.cwd, canonical));
        // The stack is bounded: an agent that cds a thousand times should not
        // accumulate a thousand paths it will never walk back through.
        if self.history.len() > 64 {
            self.history.remove(0);
        }

        self.variables.insert("PWD".to_string(), self.cwd.display().to_string());
        Output::ok(String::new())
    }

    pub fn export(&mut self, arguments: &[String]) -> Output {
        if arguments.is_empty() {
            let mut names: Vec<&String> = self.variables.keys().collect();
            names.sort();
            let lines: Vec<String> = names
                .iter()
                .map(|name| {
                    let value = &self.variables[*name];
                    // Secrets are masked here for the same reason `env` masks
                    // them: this output lands in a transcript.
                    let shown = if pi_builtins::data::looks_secret(name) {
                        pi_builtins::data::mask(value)
                    } else {
                        value.clone()
                    };
                    format!("export {name}={shown}")
                })
                .collect();
            return Output::ok(pi_builtins::text::from_lines(&lines));
        }

        for argument in arguments {
            match argument.split_once('=') {
                Some((name, value)) => {
                    self.variables.insert(name.to_string(), value.to_string());
                }
                // `export NAME` with no value marks an existing variable, which
                // in this model it already is.
                None => {
                    self.variables.entry(argument.clone()).or_default();
                }
            }
        }
        Output::ok(String::new())
    }

    pub fn alias(&mut self, arguments: &[String]) -> Output {
        if arguments.is_empty() {
            let mut names: Vec<&String> = self.aliases.keys().collect();
            names.sort();
            let lines: Vec<String> = names
                .iter()
                .map(|name| format!("alias {name}='{}'", self.aliases[*name]))
                .collect();
            return Output::ok(pi_builtins::text::from_lines(&lines));
        }

        for argument in arguments {
            match argument.split_once('=') {
                Some((name, value)) => {
                    let value = value.trim_matches(['\'', '"']);
                    self.aliases.insert(name.to_string(), value.to_string());
                }
                None => match self.aliases.get(argument) {
                    Some(value) => return Output::ok(format!("alias {argument}='{value}'\n")),
                    None => return Output::fail(format!("alias: {argument}: not found"), 1),
                },
            }
        }
        Output::ok(String::new())
    }
}

/// What a session is allowed to run.
///
/// This is a second line of defence, not the first: the agent's permission
/// layer decides whether a command runs at all. What this catches is the
/// command that was approved in one form and expanded into another — a glob
/// that resolved to a system path, a variable that turned out to hold `/`.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Commands never run, whatever the arguments.
    pub denied: Vec<String>,
    /// When set, the session may not leave this directory tree.
    pub root: Option<PathBuf>,
    /// Refuse commands whose arguments name a path outside `root`.
    pub confine_paths: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            // Not a security boundary — these are the commands whose failure
            // mode is unrecoverable, listed so a typo cannot reach them.
            denied: ["shutdown", "reboot", "halt", "mkfs", "fdisk", "diskpart", "format"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            root: None,
            confine_paths: false,
        }
    }
}

impl Policy {
    /// A permissive policy, for a session the caller has already gated.
    pub fn unrestricted() -> Self {
        Policy { denied: Vec::new(), root: None, confine_paths: false }
    }

    /// Confines a session to one directory tree.
    pub fn confined(root: impl Into<PathBuf>) -> Self {
        Policy { root: Some(root.into()), confine_paths: true, ..Default::default() }
    }

    /// Why a command is refused, or `None` to allow it.
    pub fn refuse(&self, name: &str, arguments: &[String]) -> Option<String> {
        let base = Path::new(name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| name.to_lowercase());

        if self.denied.iter().any(|denied| denied.to_lowercase() == base) {
            return Some("refused by policy".to_string());
        }

        if self.confine_paths {
            for argument in arguments {
                // Only arguments that look like paths are checked: refusing
                // every string containing a slash would block URLs and regexes.
                if !argument.starts_with('/') && !argument.starts_with("..") && !is_windows_absolute(argument) {
                    continue;
                }
                if let Some(reason) = self.refuse_directory(Path::new(argument)) {
                    return Some(reason);
                }
            }
        }

        None
    }

    /// Why a path is out of bounds, or `None`.
    pub fn refuse_directory(&self, path: &Path) -> Option<String> {
        let root = self.root.as_ref()?;
        // Compare canonical forms where possible: `..` and symlinks otherwise
        // walk straight out of the root while the string still looks inside it.
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());

        if canonical.starts_with(&canonical_root) {
            return None;
        }
        Some(format!("{} is outside {}", canonical.display(), canonical_root.display()))
    }
}

fn is_windows_absolute(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_starts_from_the_real_environment() {
        let session = Session::new(".");
        // Without PATH the session cannot spawn anything at all.
        assert!(session.variables.contains_key("PATH") || session.variables.contains_key("Path"));
    }

    #[test]
    fn cd_updates_pwd_and_remembers_the_previous_directory() {
        let temp = std::env::temp_dir();
        let mut session = Session::new(&temp);
        let start = session.cwd.clone();

        assert_eq!(session.cd(Some(&temp.display().to_string())).code, 0);
        assert!(session.variables.contains_key("PWD"));

        assert_eq!(session.cd(Some("-")).code, 0);
        assert_eq!(
            std::fs::canonicalize(&session.cwd).unwrap(),
            std::fs::canonicalize(start).unwrap()
        );
    }

    #[test]
    fn cd_to_a_missing_directory_reports_rather_than_moving() {
        let mut session = Session::new(std::env::temp_dir());
        let before = session.cwd.clone();
        let output = session.cd(Some("definitely-not-a-real-directory"));
        assert_ne!(output.code, 0);
        assert_eq!(session.cwd, before);
    }

    #[test]
    fn export_masks_secrets_when_listing() {
        let mut session = Session::new(".");
        session.variables.clear();
        session
            .variables
            .insert("OPENROUTER_API_KEY".to_string(), "sk-or-v1-abcdefghijklmnop".to_string());

        let listed = session.export(&[]).stdout;
        assert!(!listed.contains("abcdefghijklmnop"), "{listed}");
        assert!(listed.contains("OPENROUTER_API_KEY"));
    }

    #[test]
    fn a_confined_policy_refuses_paths_outside_its_root() {
        let temp = std::env::temp_dir();
        let policy = Policy::confined(&temp);
        assert!(policy.refuse_directory(Path::new("/")).is_some());
        assert!(policy.refuse_directory(&temp).is_none());
    }

    #[test]
    fn a_confined_policy_ignores_arguments_that_are_not_paths() {
        let policy = Policy::confined(std::env::temp_dir());
        // A regex and a URL both contain slashes and are not paths.
        assert!(policy.refuse("grep", &["a/b|c".to_string()]).is_none());
        assert!(policy.refuse("curl", &["https://example.com".to_string()]).is_none());
    }

    #[test]
    fn denied_commands_are_matched_by_name_not_path() {
        let policy = Policy::default();
        assert!(policy.refuse("shutdown", &[]).is_some());
        assert!(policy.refuse("/sbin/shutdown", &[]).is_some());
        assert!(policy.refuse("SHUTDOWN.EXE", &[]).is_some());
        assert!(policy.refuse("ls", &[]).is_none());
    }
}
