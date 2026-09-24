//! Three-way merge over snapshots.
//!
//! The three sides are the **base** (the source when the view was made), the
//! **source** (the tree now, which may have moved), and the **view** (what the
//! sub-agent produced). The question for each path is whether the view's change
//! can be applied without discarding a change made to the source in the
//! meantime.
//!
//! The rule is strict on purpose. Where both sides changed a file, this refuses
//! rather than picking one or attempting a line-level merge. A sub-agent's edit
//! silently overwriting the user's is the exact failure isolation exists to
//! prevent, and a wrong automatic resolution is harder to notice than a
//! reported conflict.

use crate::Snapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Added(String),
    Modified(String),
    Removed(String),
}

impl Change {
    pub fn path(&self) -> &str {
        match self {
            Change::Added(path) | Change::Modified(path) | Change::Removed(path) => path,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Change::Added(_) => "added",
            Change::Modified(_) => "modified",
            Change::Removed(_) => "removed",
        }
    }
}

/// Why a change could not be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub path: String,
    pub reason: Reason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Both sides changed the file to different content.
    BothModified,
    /// The view edited a file the source deleted.
    ModifiedAndDeleted,
    /// The view deleted a file the source edited.
    DeletedAndModified,
    /// Both sides created the same path with different content.
    BothAdded,
}

impl Reason {
    pub fn describe(&self) -> &'static str {
        match self {
            Reason::BothModified => "changed in both the view and the source",
            Reason::ModifiedAndDeleted => "edited in the view, deleted at the source",
            Reason::DeletedAndModified => "deleted in the view, edited at the source",
            Reason::BothAdded => "created in both, with different content",
        }
    }
}

/// How a conflict could be settled, for a caller that wants to offer choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    TakeView,
    TakeSource,
    Skip,
}

#[derive(Debug, Clone, Default)]
pub struct MergePlan {
    /// Changes that apply cleanly.
    pub apply: Vec<Change>,
    /// Changes that cannot be applied without a decision.
    pub conflicts: Vec<Conflict>,
    /// Changes the view made that the source had already made identically.
    pub already_applied: Vec<String>,
}

impl MergePlan {
    pub fn is_clean(&self) -> bool {
        self.conflicts.is_empty()
    }

    /// A report of what the merge will and will not do.
    pub fn report(&self) -> String {
        if self.apply.is_empty() && self.conflicts.is_empty() {
            return "nothing to merge".to_string();
        }

        let mut out = String::new();

        if !self.apply.is_empty() {
            out.push_str(&format!("{} change(s) to apply:\n", self.apply.len()));
            for change in &self.apply {
                out.push_str(&format!("  {} {}\n", change.label(), change.path()));
            }
        }

        if !self.conflicts.is_empty() {
            out.push_str(&format!("\n{} conflict(s), not applied:\n", self.conflicts.len()));
            for conflict in &self.conflicts {
                out.push_str(&format!("  {} — {}\n", conflict.path, conflict.reason.describe()));
            }
        }

        if !self.already_applied.is_empty() {
            out.push_str(&format!(
                "\n{} change(s) the source already had\n",
                self.already_applied.len()
            ));
        }

        out
    }
}

/// Plans a three-way merge.
pub fn merge(base: &Snapshot, source: &Snapshot, view: &Snapshot) -> MergePlan {
    let mut plan = MergePlan::default();

    // Every path mentioned by any of the three sides.
    let mut paths: Vec<&String> = base
        .files
        .keys()
        .chain(source.files.keys())
        .chain(view.files.keys())
        .collect();
    paths.sort();
    paths.dedup();

    for path in paths {
        let in_base = base.get(path);
        let in_source = source.get(path);
        let in_view = view.get(path);

        // The view did not change it: nothing to merge, whatever the source did.
        if in_base == in_view {
            continue;
        }

        match (in_base, in_source, in_view) {
            // Created in the view.
            (None, None, Some(_)) => plan.apply.push(Change::Added(path.clone())),

            (None, Some(source_hash), Some(view_hash)) => {
                if source_hash == view_hash {
                    // Both created it identically — two agents reaching the
                    // same answer is not a conflict.
                    plan.already_applied.push(path.clone());
                } else {
                    plan.conflicts
                        .push(Conflict { path: path.clone(), reason: Reason::BothAdded });
                }
            }

            // Edited in the view.
            (Some(base_hash), Some(source_hash), Some(view_hash)) => {
                if source_hash == base_hash {
                    // The source did not move; the view's edit applies.
                    plan.apply.push(Change::Modified(path.clone()));
                } else if source_hash == view_hash {
                    plan.already_applied.push(path.clone());
                } else {
                    plan.conflicts
                        .push(Conflict { path: path.clone(), reason: Reason::BothModified });
                }
            }

            (Some(_), None, Some(_)) => {
                plan.conflicts
                    .push(Conflict { path: path.clone(), reason: Reason::ModifiedAndDeleted });
            }

            // Deleted in the view.
            (Some(base_hash), Some(source_hash), None) => {
                if source_hash == base_hash {
                    plan.apply.push(Change::Removed(path.clone()));
                } else {
                    plan.conflicts
                        .push(Conflict { path: path.clone(), reason: Reason::DeletedAndModified });
                }
            }

            (Some(_), None, None) => {
                // Both deleted it. Agreement, not conflict.
                plan.already_applied.push(path.clone());
            }

            (None, Some(_), None) | (None, None, None) => {}
        }
    }

    plan
}

/// Applies resolutions to a plan, moving resolved conflicts into `apply`.
pub fn resolve(plan: &mut MergePlan, resolutions: &[(String, Resolution)]) {
    for (path, resolution) in resolutions {
        let Some(position) = plan.conflicts.iter().position(|c| c.path == *path) else { continue };
        let conflict = plan.conflicts.remove(position);

        match resolution {
            Resolution::TakeView => {
                // Which change it is depends on why it conflicted.
                plan.apply.push(match conflict.reason {
                    Reason::DeletedAndModified => Change::Removed(conflict.path),
                    Reason::BothAdded => Change::Added(conflict.path),
                    _ => Change::Modified(conflict.path),
                });
            }
            // Taking the source means doing nothing, which is the safe default
            // and why it is not represented as a change.
            Resolution::TakeSource | Resolution::Skip => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn snapshot(entries: &[(&str, &str)]) -> Snapshot {
        let mut files = BTreeMap::new();
        for (path, hash) in entries {
            files.insert(path.to_string(), hash.to_string());
        }
        Snapshot { files }
    }

    #[test]
    fn an_untouched_tree_merges_to_nothing() {
        let base = snapshot(&[("a", "1"), ("b", "2")]);
        let plan = merge(&base, &base, &base);
        assert!(plan.apply.is_empty());
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.report(), "nothing to merge");
    }

    #[test]
    fn an_edit_only_in_the_view_applies() {
        let base = snapshot(&[("a", "1")]);
        let view = snapshot(&[("a", "2")]);
        let plan = merge(&base, &base, &view);
        assert_eq!(plan.apply, vec![Change::Modified("a".to_string())]);
        assert!(plan.is_clean());
    }

    #[test]
    fn an_edit_only_at_the_source_is_left_alone() {
        // The view never touched it, so there is nothing to merge — and the
        // source's version must survive.
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "9")]);
        let plan = merge(&base, &source, &base);
        assert!(plan.apply.is_empty());
        assert!(plan.is_clean());
    }

    #[test]
    fn both_sides_editing_conflicts() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "2")]);
        let view = snapshot(&[("a", "3")]);
        let plan = merge(&base, &source, &view);

        assert!(plan.apply.is_empty());
        assert_eq!(plan.conflicts[0].reason, Reason::BothModified);
    }

    #[test]
    fn both_sides_making_the_same_edit_is_not_a_conflict() {
        let base = snapshot(&[("a", "1")]);
        let converged = snapshot(&[("a", "2")]);
        let plan = merge(&base, &converged, &converged);

        assert!(plan.is_clean());
        assert!(plan.apply.is_empty());
        assert_eq!(plan.already_applied, vec!["a".to_string()]);
    }

    #[test]
    fn a_new_file_applies() {
        let base = snapshot(&[]);
        let view = snapshot(&[("new", "1")]);
        let plan = merge(&base, &base, &view);
        assert_eq!(plan.apply, vec![Change::Added("new".to_string())]);
    }

    #[test]
    fn the_same_new_file_with_different_content_conflicts() {
        let base = snapshot(&[]);
        let source = snapshot(&[("new", "1")]);
        let view = snapshot(&[("new", "2")]);
        let plan = merge(&base, &source, &view);
        assert_eq!(plan.conflicts[0].reason, Reason::BothAdded);
    }

    #[test]
    fn a_deletion_applies_when_the_source_did_not_move() {
        let base = snapshot(&[("a", "1")]);
        let view = snapshot(&[]);
        let plan = merge(&base, &base, &view);
        assert_eq!(plan.apply, vec![Change::Removed("a".to_string())]);
    }

    #[test]
    fn deleting_a_file_the_source_edited_conflicts() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "2")]);
        let view = snapshot(&[]);
        let plan = merge(&base, &source, &view);
        assert_eq!(plan.conflicts[0].reason, Reason::DeletedAndModified);
    }

    #[test]
    fn editing_a_file_the_source_deleted_conflicts() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[]);
        let view = snapshot(&[("a", "2")]);
        let plan = merge(&base, &source, &view);
        assert_eq!(plan.conflicts[0].reason, Reason::ModifiedAndDeleted);
    }

    #[test]
    fn both_sides_deleting_agree() {
        let base = snapshot(&[("a", "1")]);
        let empty = snapshot(&[]);
        let plan = merge(&base, &empty, &empty);
        assert!(plan.is_clean());
        assert!(plan.apply.is_empty());
    }

    #[test]
    fn a_mixed_merge_separates_what_applies_from_what_does_not() {
        let base = snapshot(&[("clean", "1"), ("contested", "1"), ("untouched", "1")]);
        let source = snapshot(&[("clean", "1"), ("contested", "2"), ("untouched", "1")]);
        let view = snapshot(&[("clean", "9"), ("contested", "3"), ("untouched", "1"), ("new", "1")]);

        let plan = merge(&base, &source, &view);
        let applied: Vec<&str> = plan.apply.iter().map(Change::path).collect();

        assert!(applied.contains(&"clean"));
        assert!(applied.contains(&"new"));
        assert!(!applied.contains(&"contested"));
        assert_eq!(plan.conflicts.len(), 1);
    }

    #[test]
    fn resolving_a_conflict_moves_it_into_the_plan() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "2")]);
        let view = snapshot(&[("a", "3")]);
        let mut plan = merge(&base, &source, &view);

        resolve(&mut plan, &[("a".to_string(), Resolution::TakeView)]);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.apply, vec![Change::Modified("a".to_string())]);
    }

    #[test]
    fn taking_the_source_applies_nothing() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "2")]);
        let view = snapshot(&[("a", "3")]);
        let mut plan = merge(&base, &source, &view);

        resolve(&mut plan, &[("a".to_string(), Resolution::TakeSource)]);
        assert!(plan.conflicts.is_empty());
        assert!(plan.apply.is_empty());
    }

    #[test]
    fn the_report_names_every_conflict() {
        let base = snapshot(&[("a", "1")]);
        let source = snapshot(&[("a", "2")]);
        let view = snapshot(&[("a", "3")]);
        let report = merge(&base, &source, &view).report();

        assert!(report.contains("1 conflict"));
        assert!(report.contains("changed in both"));
    }
}
