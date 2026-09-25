//! # pi-iso
//!
//! Copy-on-write task isolation: a sub-agent works on its own view of the tree,
//! and its changes are merged back only after validation.
//!
//! The problem this solves is that parallel sub-agents editing one working tree
//! corrupt each other's work, and the corruption is silent — agent A reads a
//! file, agent B rewrites it, agent A writes back its edit of the stale
//! version, and B's work is gone with no error anywhere.
//!
//! A view is made of clones where the file system can clone — APFS
//! `clonefile` on macOS, a `FICLONE` reflink on btrfs and XFS, ReFS block
//! cloning on a Windows Dev Drive — so it costs metadata, not a second copy
//! of the tree; elsewhere, of copies. Each file that is cloned shares its
//! blocks with the original until one of them is written, which is exactly
//! the isolation a view needs. (overlayfs and ProjFS would do it for a whole
//! directory, but each needs privileges or a service kept running for the
//! life of the view; one system call per file needs neither.)
//!
//! What is fully implemented, and is the part that actually matters, is the
//! **merge**: deciding which changes in an isolated view can be applied back to
//! a tree that may have moved underneath it, and refusing the ones that cannot.

pub mod clone;
pub mod merge;

pub use clone::Cloner;
pub use merge::{merge, Change, Conflict, MergePlan, Resolution};

use pi_builtins::hash::sha256_hex;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// macOS APFS `clonefile`: instant, blocks shared until written.
    Apfs,
    /// btrfs / XFS / bcachefs reflink, through `FICLONE`.
    Reflink,
    /// ReFS block cloning, as a Windows Dev Drive has.
    BlockClone,
    /// A full copy. Correct everywhere, slow on a large tree.
    Copy,
}

impl Backend {
    pub fn label(&self) -> &'static str {
        match self {
            Backend::Apfs => "apfs-clonefile",
            Backend::Reflink => "reflink",
            Backend::BlockClone => "refs-block-clone",
            Backend::Copy => "copy",
        }
    }

    fn from_method(method: &str) -> Backend {
        match method {
            "apfs-clonefile" => Backend::Apfs,
            "reflink" => Backend::Reflink,
            "refs-block-clone" => Backend::BlockClone,
            _ => Backend::Copy,
        }
    }
}

/// The cloning this platform would try for `path`: its method where the
/// file system is known to support it, the plain copy where it is known not
/// to. What a view actually used is `View::backend`, decided by trying.
pub fn detect(path: &Path) -> Backend {
    if cfg!(target_os = "macos") {
        // APFS is the default on every supported macOS version.
        return Backend::Apfs;
    }
    if cfg!(target_os = "linux") {
        if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
            if mount_type(&mounts, path).is_some_and(|kind| matches!(kind.as_str(), "btrfs" | "xfs" | "bcachefs")) {
                return Backend::Reflink;
            }
        }
        return Backend::Copy;
    }
    if cfg!(windows) {
        return Backend::BlockClone;
    }
    Backend::Copy
}

/// The filesystem type of the longest mount point containing `path`.
fn mount_type(mounts: &str, path: &Path) -> Option<String> {
    let target = path.to_string_lossy();
    let mut best: Option<(usize, String)> = None;

    for line in mounts.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let mount_point = fields[1];
        // Longest match wins: `/` matches everything, and taking it would
        // report the root filesystem's type for a path on a mounted volume.
        if target.starts_with(mount_point)
            && best.as_ref().is_none_or(|(length, _)| mount_point.len() > *length)
        {
            best = Some((mount_point.len(), fields[2].to_string()));
        }
    }

    best.map(|(_, kind)| kind)
}

/// A snapshot of a tree's contents, by path and content hash.
///
/// Hashes rather than mtimes: an editor that writes a file with the same
/// content leaves a new mtime, and treating that as a change makes every merge
/// look conflicted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub files: BTreeMap<String, String>,
}

impl Snapshot {
    /// Hashes every file under `root`.
    pub fn of(root: &Path) -> Result<Snapshot, String> {
        Snapshot::of_excluding(root, &[])
    }

    /// Hashes every file under `root`, skipping any path with a component
    /// named in `exclude` — `.git`, `node_modules`, and the like, which an
    /// isolated view should neither copy nor merge back.
    pub fn of_excluding(root: &Path, exclude: &[String]) -> Result<Snapshot, String> {
        let mut files = BTreeMap::new();

        let listing = pi_builtins::data::find(
            root,
            &pi_builtins::data::FindOptions {
                kind: Some(pi_builtins::data::EntryKind::File),
                limit: Some(200_000),
                ..Default::default()
            },
        );

        for relative in listing.stdout.lines() {
            if relative.starts_with("...") {
                continue;
            }
            if relative
                .split(['/', '\\'])
                .any(|component| exclude.iter().any(|skip| skip == component))
            {
                continue;
            }
            let bytes = fs::read(root.join(relative))
                .map_err(|error| format!("{relative}: {error}"))?;
            files.insert(relative.to_string(), sha256_hex(&bytes));
        }

        Ok(Snapshot { files })
    }

    pub fn get(&self, path: &str) -> Option<&String> {
        self.files.get(path)
    }

    /// Paths that differ between two snapshots.
    pub fn diff(&self, other: &Snapshot) -> Vec<Change> {
        let mut changes = Vec::new();

        for (path, hash) in &other.files {
            match self.files.get(path) {
                None => changes.push(Change::Added(path.clone())),
                Some(before) if before != hash => changes.push(Change::Modified(path.clone())),
                Some(_) => {}
            }
        }

        for path in self.files.keys() {
            if !other.files.contains_key(path) {
                changes.push(Change::Removed(path.clone()));
            }
        }

        changes.sort_by_key(|change| change.path().to_string());
        changes
    }
}

/// An isolated view of a tree.
pub struct View {
    pub root: PathBuf,
    pub source: PathBuf,
    /// How the view was filled: a clone method when any file was cloned.
    pub backend: Backend,
    /// How many files were cloned rather than copied.
    pub cloned: usize,
    /// The source's state when the view was made, for three-way merging.
    pub base: Snapshot,
    /// Path components never copied in or merged back.
    pub exclude: Vec<String>,
}

impl View {
    /// Creates an isolated view of `source` at `destination`.
    pub fn create(source: &Path, destination: &Path) -> Result<View, String> {
        View::create_excluding(source, destination, &[])
    }

    /// Creates an isolated view that leaves out any path with a component in
    /// `exclude`. Only the files in the base snapshot are copied, so what is
    /// excluded from the snapshot is excluded from the copy by construction.
    pub fn create_excluding(
        source: &Path,
        destination: &Path,
        exclude: &[String],
    ) -> Result<View, String> {
        let base = Snapshot::of_excluding(source, exclude)?;

        fs::create_dir_all(destination)
            .map_err(|error| format!("{}: {error}", destination.display()))?;

        // Only the files in the snapshot: what is excluded from it is
        // excluded from the view by construction.
        let mut cloner = Cloner::default();
        for relative in base.files.keys() {
            let target = destination.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            cloner.place(&source.join(relative), &target)?;
        }

        Ok(View {
            root: destination.to_path_buf(),
            source: source.to_path_buf(),
            backend: Backend::from_method(cloner.method()),
            cloned: cloner.cloned,
            base,
            exclude: exclude.to_vec(),
        })
    }

    /// What changed inside the view since it was created.
    pub fn changes(&self) -> Result<Vec<Change>, String> {
        Ok(self.base.diff(&Snapshot::of_excluding(&self.root, &self.exclude)?))
    }

    /// Plans a merge back into the source.
    pub fn plan(&self) -> Result<MergePlan, String> {
        let current_source = Snapshot::of_excluding(&self.source, &self.exclude)?;
        let view = Snapshot::of_excluding(&self.root, &self.exclude)?;
        Ok(merge(&self.base, &current_source, &view))
    }

    /// Applies a plan's non-conflicting changes to the source.
    ///
    /// Conflicts are never applied. A merge that silently picks a side is how
    /// a sub-agent's work overwrites the user's.
    pub fn apply(&self, plan: &MergePlan) -> Result<usize, String> {
        let mut applied = 0;

        for change in &plan.apply {
            let target = self.source.join(change.path());
            match change {
                Change::Added(path) | Change::Modified(path) => {
                    let bytes = fs::read(self.root.join(path))
                        .map_err(|error| format!("{path}: {error}"))?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|error| format!("{}: {error}", parent.display()))?;
                    }
                    fs::write(&target, bytes)
                        .map_err(|error| format!("{}: {error}", target.display()))?;
                }
                Change::Removed(_) => {
                    fs::remove_file(&target)
                        .map_err(|error| format!("{}: {error}", target.display()))?;
                }
            }
            applied += 1;
        }

        Ok(applied)
    }

    /// Removes the view.
    pub fn discard(self) -> Result<(), String> {
        fs::remove_dir_all(&self.root).map_err(|error| format!("{}: {error}", self.root.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-iso-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn seeded() -> PathBuf {
        let root = temp("source");
        fs::write(root.join("a.txt"), "original a").unwrap();
        fs::write(root.join("b.txt"), "original b").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/c.txt"), "original c").unwrap();
        root
    }

    #[test]
    fn detection_reports_a_backend_for_this_platform() {
        let backend = detect(Path::new("."));
        if cfg!(windows) {
            assert_eq!(backend, Backend::BlockClone);
        } else if cfg!(target_os = "macos") {
            assert_eq!(backend, Backend::Apfs);
        }
        // Whatever is detected, the label is reportable.
        assert!(!backend.label().is_empty());
    }

    #[test]
    fn the_longest_mount_point_wins() {
        let mounts = "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /home/user/data btrfs rw 0 0\n";
        assert_eq!(
            mount_type(mounts, Path::new("/home/user/data/project")).as_deref(),
            Some("btrfs")
        );
        assert_eq!(mount_type(mounts, Path::new("/etc")).as_deref(), Some("ext4"));
    }

    #[test]
    fn a_snapshot_hashes_every_file() {
        let root = seeded();
        let snapshot = Snapshot::of(&root).unwrap();
        assert_eq!(snapshot.files.len(), 3);
        assert!(snapshot.get("a.txt").is_some());
        assert!(snapshot.get("nested/c.txt").is_some());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn identical_content_hashes_the_same_regardless_of_mtime() {
        // The bug this prevents: an editor rewriting a file unchanged, and the
        // merge treating every such file as modified.
        let root = seeded();
        let before = Snapshot::of(&root).unwrap();
        fs::write(root.join("a.txt"), "original a").unwrap();
        let after = Snapshot::of(&root).unwrap();
        assert_eq!(before, after);
        assert!(before.diff(&after).is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_view_starts_identical_to_its_source() {
        let source = seeded();
        let destination = temp("view").join("copy");

        let view = View::create(&source, &destination).unwrap();
        assert!(view.changes().unwrap().is_empty());
        assert_eq!(fs::read_to_string(destination.join("a.txt")).unwrap(), "original a");

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }

    #[test]
    fn edits_in_a_view_do_not_touch_the_source() {
        let source = seeded();
        let destination = temp("view").join("copy");
        let view = View::create(&source, &destination).unwrap();

        fs::write(destination.join("a.txt"), "changed in the view").unwrap();

        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "original a");
        assert_eq!(view.changes().unwrap().len(), 1);

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }

    #[test]
    fn a_clean_merge_applies_back() {
        let source = seeded();
        let destination = temp("view").join("copy");
        let view = View::create(&source, &destination).unwrap();

        fs::write(destination.join("a.txt"), "edited by the sub-agent").unwrap();
        fs::write(destination.join("new.txt"), "created by the sub-agent").unwrap();

        let plan = view.plan().unwrap();
        assert!(plan.conflicts.is_empty(), "{plan:?}");
        assert_eq!(view.apply(&plan).unwrap(), 2);

        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "edited by the sub-agent");
        assert!(source.join("new.txt").exists());

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }

    #[test]
    fn a_concurrent_edit_conflicts_rather_than_overwriting() {
        // The failure this whole crate exists to prevent.
        let source = seeded();
        let destination = temp("view").join("copy");
        let view = View::create(&source, &destination).unwrap();

        fs::write(destination.join("a.txt"), "the sub-agent's version").unwrap();
        fs::write(source.join("a.txt"), "the user's version").unwrap();

        let plan = view.plan().unwrap();
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(plan.conflicts[0].path, "a.txt");
        assert!(plan.apply.is_empty());

        view.apply(&plan).unwrap();
        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "the user's version");

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }

    #[test]
    fn an_untouched_file_changed_at_the_source_is_left_alone() {
        let source = seeded();
        let destination = temp("view").join("copy");
        let view = View::create(&source, &destination).unwrap();

        // The view never touched b.txt, so the source's newer version stands.
        fs::write(source.join("b.txt"), "the user's newer version").unwrap();
        fs::write(destination.join("a.txt"), "the sub-agent's edit").unwrap();

        let plan = view.plan().unwrap();
        assert!(plan.conflicts.is_empty());
        view.apply(&plan).unwrap();

        assert_eq!(fs::read_to_string(source.join("b.txt")).unwrap(), "the user's newer version");

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }

    #[test]
    fn discarding_removes_the_view() {
        let source = seeded();
        let destination = temp("view").join("copy");
        let view = View::create(&source, &destination).unwrap();
        let path = view.root.clone();

        view.discard().unwrap();
        assert!(!path.exists());
        assert!(source.join("a.txt").exists());

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(destination.parent().unwrap()).ok();
    }
}

#[cfg(test)]
mod exclude_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-iso-ex-{name}-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn excluded_directories_are_neither_copied_nor_merged() {
        let source = temp("src");
        fs::write(source.join("a.txt"), "a").unwrap();
        fs::create_dir_all(source.join("node_modules/pkg")).unwrap();
        fs::write(source.join("node_modules/pkg/index.js"), "dep").unwrap();
        let exclude = vec!["node_modules".to_string(), ".git".to_string()];

        let destination = temp("view");
        let view = View::create_excluding(&source, &destination, &exclude).unwrap();
        assert!(destination.join("a.txt").exists());
        assert!(!destination.join("node_modules").exists());

        fs::write(destination.join("a.txt"), "changed").unwrap();
        fs::write(destination.join("b.txt"), "new").unwrap();
        let plan = view.plan().unwrap();
        assert!(plan.is_clean());
        assert_eq!(view.apply(&plan).unwrap(), 2);
        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "changed");
        // The dependency the view never had was not "deleted" by the merge.
        assert!(source.join("node_modules/pkg/index.js").exists());

        view.discard().unwrap();
        fs::remove_dir_all(&source).ok();
    }
}
