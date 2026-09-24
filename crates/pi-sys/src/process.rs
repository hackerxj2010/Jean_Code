//! Process trees, and killing them completely (architecture §6.1 `process`).
//!
//! The problem this solves: an agent runs `npm run dev`, which spawns a shell,
//! which spawns node, which spawns esbuild. Killing the process the agent
//! started leaves three orphans holding a port. The next run fails with
//! `EADDRINUSE` and nothing on screen explains why.
//!
//! So killing is done by *tree*: enumerate the descendants, signal the leaves
//! first, then the parents. Signalling a parent before its children is what
//! produces orphans re-parented to init, which no longer answer to anyone.
//!
//! Std-only. Enumeration goes through the platform's own tools — `/proc` on
//! Linux, `ps` on macOS, `wmic`/`tasklist` on Windows — rather than a crate,
//! because the alternative brings a dependency for what is three readers.

use std::collections::{HashMap, HashSet};
use std::process::Command;

/// One process, as much as the platform will say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    /// The executable name, without a path.
    pub name: String,
    /// The full command line, when the platform exposes it.
    pub command: Option<String>,
}

/// Every process on the machine, keyed by pid.
///
/// A snapshot, not a live view: a process may exit between this call and the
/// next, which is why every operation here tolerates a pid that has vanished.
pub fn snapshot() -> Result<Vec<Process>, String> {
    #[cfg(target_os = "linux")]
    return snapshot_proc();

    #[cfg(target_os = "windows")]
    return snapshot_windows();

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return snapshot_ps();
}

/// Every descendant of `root`, deepest first.
///
/// The order is the point: killing depth-first means a parent is only signalled
/// once its children are already gone, so nothing is re-parented mid-kill.
pub fn descendants(root: u32) -> Result<Vec<Process>, String> {
    let all = snapshot()?;
    Ok(descendants_of(root, &all))
}

/// The tree-walk, split out so it can be tested without a real process table.
pub fn descendants_of(root: u32, all: &[Process]) -> Vec<Process> {
    let mut children: HashMap<u32, Vec<&Process>> = HashMap::new();
    for process in all {
        children.entry(process.parent).or_default().push(process);
    }

    let mut out: Vec<Process> = Vec::new();
    // Guards against a cycle. A well-formed process table has none, but a
    // pid that has been reused can produce one, and an infinite walk here
    // would hang whatever asked to clean up.
    let mut seen: HashSet<u32> = HashSet::new();
    seen.insert(root);

    fn visit(
        pid: u32,
        children: &HashMap<u32, Vec<&Process>>,
        seen: &mut HashSet<u32>,
        out: &mut Vec<Process>,
    ) {
        let Some(kids) = children.get(&pid) else { return };
        for child in kids {
            if !seen.insert(child.pid) {
                continue;
            }
            visit(child.pid, children, seen, out);
            // Pushed *after* recursing, so the deepest come first.
            out.push((*child).clone());
        }
    }

    visit(root, &children, &mut seen, &mut out);
    out
}

/// What a kill did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KillReport {
    /// Pids that were signalled and are gone.
    pub killed: Vec<u32>,
    /// Pids that could not be signalled, with the reason.
    pub failed: Vec<(u32, String)>,
    /// Pids that had already exited before the signal reached them.
    pub already_gone: Vec<u32>,
}

impl KillReport {
    pub fn total(&self) -> usize {
        self.killed.len() + self.failed.len() + self.already_gone.len()
    }

    /// One line, for the tool result the agent reads.
    pub fn summary(&self) -> String {
        if self.total() == 0 {
            return "no such process".to_string();
        }

        let mut parts = Vec::new();
        if !self.killed.is_empty() {
            parts.push(format!("killed {}", self.killed.len()));
        }
        if !self.already_gone.is_empty() {
            parts.push(format!("{} already gone", self.already_gone.len()));
        }
        if !self.failed.is_empty() {
            // Named individually: "3 failed" tells the agent nothing it can act
            // on, and a permission failure reads very differently from a
            // process that outlived its parent.
            let detail: Vec<String> = self
                .failed
                .iter()
                .map(|(pid, why)| format!("{pid} ({why})"))
                .collect();
            parts.push(format!("could not kill {}", detail.join(", ")));
        }
        parts.join(", ")
    }
}

/// Kills a process and everything it spawned.
///
/// Descendants first, then the root. `include_root` exists because the caller
/// sometimes owns the root by other means — a `Child` handle it will `wait` on
/// — and killing it here would leave that handle waiting on a corpse.
pub fn kill_tree(root: u32, include_root: bool) -> Result<KillReport, String> {
    let mut report = KillReport::default();

    // Enumeration failing is not fatal: the root can still be killed, and one
    // dead process is better than none.
    let targets = match descendants(root) {
        Ok(found) => found.into_iter().map(|p| p.pid).collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    for pid in targets {
        record(&mut report, pid, kill_one(pid));
    }

    if include_root {
        record(&mut report, root, kill_one(root));
    }

    Ok(report)
}

fn record(report: &mut KillReport, pid: u32, outcome: Result<bool, String>) {
    match outcome {
        Ok(true) => report.killed.push(pid),
        Ok(false) => report.already_gone.push(pid),
        Err(why) => report.failed.push((pid, why)),
    }
}

/// Signals one process. `Ok(false)` means it had already exited.
pub fn kill_one(pid: u32) -> Result<bool, String> {
    // Refusing pid 0 and 1 is not paranoia: pid 0 means "every process in the
    // group" to `kill(2)`, and pid 1 is init. An arithmetic slip that produced
    // either would take down the machine rather than a build.
    if pid <= 1 {
        return Err("refusing to signal pid 0 or 1".to_string());
    }

    if !exists(pid) {
        return Ok(false);
    }

    #[cfg(windows)]
    let result = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();

    #[cfg(not(windows))]
    let result = Command::new("kill").args(["-9", &pid.to_string()]).output();

    match result {
        Ok(output) if output.status.success() => Ok(true),
        // A process that exited between the check above and the signal is a
        // success, not a failure — the caller wanted it gone and it is.
        Ok(_) if !exists(pid) => Ok(false),
        Ok(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// Whether a pid is live.
pub fn exists(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        return std::path::Path::new(&format!("/proc/{pid}")).exists();
    }

    #[cfg(windows)]
    {
        let Ok(output) = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
        else {
            return false;
        };
        // `tasklist` exits 0 with an "INFO: No tasks" line when nothing
        // matches, so the exit code says nothing and the output must be read.
        let text = String::from_utf8_lossy(&output.stdout);
        return text.contains(&format!("\"{pid}\""));
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}

// ---- platform enumeration ---------------------------------------------------

#[cfg(target_os = "linux")]
fn snapshot_proc() -> Result<Vec<Process>, String> {
    let mut out = Vec::new();

    let entries = std::fs::read_dir("/proc").map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|text| text.parse::<u32>().ok()) else {
            continue;
        };

        // Read `stat` rather than `status`: it is one line and its field order
        // is stable, where `status` is a key-value block that has gained and
        // lost keys across kernel versions.
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };

        // The executable name sits in parentheses and may itself contain
        // spaces or parentheses, so the fields after it are found from the
        // *last* `)` rather than by splitting the whole line.
        let Some(close) = stat.rfind(')') else { continue };
        let Some(open) = stat.find('(') else { continue };

        let name = stat[open + 1..close].to_string();
        let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
        // After the name: state, then ppid.
        let parent = rest.get(1).and_then(|text| text.parse().ok()).unwrap_or(0);

        let command = std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
            .ok()
            .map(|raw| raw.replace('\0', " ").trim().to_string())
            .filter(|text| !text.is_empty());

        out.push(Process { pid, parent, name, command });
    }

    Ok(out)
}

#[cfg(windows)]
fn snapshot_windows() -> Result<Vec<Process>, String> {
    // CSV rather than the table format: a process name can contain spaces, and
    // the table is column-aligned in a way that breaks on long names.
    let output = Command::new("wmic")
        .args(["process", "get", "ProcessId,ParentProcessId,Name", "/FORMAT:CSV"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let parsed = parse_wmic_csv(&text);
            if !parsed.is_empty() {
                return Ok(parsed);
            }
        }
    }

    // `wmic` is deprecated and absent from recent Windows installs, so
    // PowerShell is the fallback rather than an error.
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name)\" }",
        ])
        .output()
        .map_err(|error| error.to_string())?;

    Ok(parse_simple_csv(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn parse_wmic_csv(text: &str) -> Vec<Process> {
    let mut out = Vec::new();
    let mut columns: Option<Vec<String>> = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let fields: Vec<&str> = line.split(',').collect();

        if columns.is_none() {
            if line.contains("ProcessId") {
                columns = Some(fields.iter().map(|f| f.trim().to_string()).collect());
            }
            continue;
        }

        let headers = columns.as_ref().unwrap();
        let index = |name: &str| headers.iter().position(|h| h == name);

        let pid = index("ProcessId")
            .and_then(|i| fields.get(i))
            .and_then(|f| f.trim().parse::<u32>().ok());
        let parent = index("ParentProcessId")
            .and_then(|i| fields.get(i))
            .and_then(|f| f.trim().parse::<u32>().ok());
        let name = index("Name").and_then(|i| fields.get(i)).map(|f| f.trim().to_string());

        if let (Some(pid), Some(parent), Some(name)) = (pid, parent, name) {
            out.push(Process { pid, parent, name, command: None });
        }
    }

    out
}

#[cfg(windows)]
fn parse_simple_csv(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.trim().splitn(3, ',').collect();
            if fields.len() < 3 {
                return None;
            }
            Some(Process {
                pid: fields[0].trim().parse().ok()?,
                parent: fields[1].trim().parse().ok()?,
                name: fields[2].trim().to_string(),
                command: None,
            })
        })
        .collect()
}

#[cfg(not(any(target_os = "linux", windows)))]
fn snapshot_ps() -> Result<Vec<Process>, String> {
    // `-o pid=,ppid=,comm=` suppresses the header, so there is no line to skip
    // and no header format to depend on.
    let output = Command::new("ps")
        .args(["-Ao", "pid=,ppid=,comm="])
        .output()
        .map_err(|error| error.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().splitn(3, char::is_whitespace);
            let pid = fields.next()?.trim().parse().ok()?;
            let parent = fields.next()?.trim().parse().ok()?;
            let name = fields.next()?.trim().to_string();
            Some(Process { pid, parent, name, command: None })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Vec<Process> {
        let make = |pid, parent, name: &str| Process {
            pid,
            parent,
            name: name.to_string(),
            command: None,
        };

        vec![
            make(1, 0, "init"),
            make(100, 1, "shell"),
            make(200, 100, "npm"),
            make(300, 200, "node"),
            make(400, 300, "esbuild"),
            // A sibling branch that must not be swept up.
            make(500, 1, "unrelated"),
        ]
    }

    #[test]
    fn finds_every_descendant() {
        let found = descendants_of(100, &table());
        let pids: Vec<u32> = found.iter().map(|p| p.pid).collect();

        assert_eq!(pids.len(), 3);
        assert!(pids.contains(&200));
        assert!(pids.contains(&300));
        assert!(pids.contains(&400));
        // The whole point of a tree kill: an unrelated branch is untouched.
        assert!(!pids.contains(&500));
    }

    #[test]
    fn orders_children_before_their_parents() {
        // Killing a parent first re-parents its children to init, where they
        // outlive the kill. Depth-first order is what prevents that.
        let found = descendants_of(100, &table());
        let pids: Vec<u32> = found.iter().map(|p| p.pid).collect();

        let esbuild = pids.iter().position(|p| *p == 400).unwrap();
        let node = pids.iter().position(|p| *p == 300).unwrap();
        let npm = pids.iter().position(|p| *p == 200).unwrap();

        assert!(esbuild < node, "esbuild must be signalled before node");
        assert!(node < npm, "node must be signalled before npm");
    }

    #[test]
    fn a_leaf_has_no_descendants() {
        assert!(descendants_of(400, &table()).is_empty());
    }

    #[test]
    fn an_unknown_pid_yields_nothing_rather_than_failing() {
        assert!(descendants_of(9999, &table()).is_empty());
    }

    #[test]
    fn a_cycle_terminates() {
        // A reused pid can produce one. Without the `seen` set this walk never
        // returns, and a cleanup that hangs is worse than one that misses.
        let cyclic = vec![
            Process { pid: 10, parent: 20, name: "a".into(), command: None },
            Process { pid: 20, parent: 10, name: "b".into(), command: None },
        ];
        let found = descendants_of(10, &cyclic);
        assert!(found.len() <= 2);
    }

    #[test]
    fn init_and_pid_zero_are_refused() {
        assert!(kill_one(0).is_err());
        assert!(kill_one(1).is_err());
    }

    #[test]
    fn the_current_process_is_visible_to_the_platform_reader() {
        // The one test that exercises the real platform path. If enumeration is
        // broken on this OS, the process running the test is missing from it.
        let all = snapshot().expect("the platform reports its processes");
        assert!(!all.is_empty());

        let me = std::process::id();
        assert!(
            all.iter().any(|process| process.pid == me),
            "the running process ({me}) is absent from the snapshot"
        );
    }

    #[test]
    fn the_current_process_exists() {
        assert!(exists(std::process::id()));
        // A pid this high is not in use on any normal system.
        assert!(!exists(4_294_967_294));
    }

    #[test]
    fn a_report_reads_as_one_line() {
        let report = KillReport {
            killed: vec![1, 2, 3],
            failed: vec![(4, "access denied".into())],
            already_gone: vec![5],
        };
        let summary = report.summary();

        assert!(summary.contains("killed 3"));
        assert!(summary.contains("1 already gone"));
        // The failure names the pid and the reason, not just a count.
        assert!(summary.contains("4 (access denied)"));

        assert_eq!(KillReport::default().summary(), "no such process");
    }
}
