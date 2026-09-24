//! Keeping the machine awake while the agent works (architecture §6.1 `power`).
//!
//! An agent run can take twenty minutes with no keyboard input. Left alone the
//! machine sleeps, the network drops, an in-flight model request dies, and the
//! session ends holding a half-applied edit. So a long run takes an assertion
//! and releases it when it finishes.
//!
//! Three assertion kinds, and the distinction matters: preventing *idle* sleep
//! is what a background task needs; preventing *display* sleep additionally
//! keeps the screen lit, which a task nobody is watching should not do. The
//! default is the weaker one.
//!
//! Every platform: `caffeinate` on macOS, `SetThreadExecutionState` via
//! PowerShell on Windows, `systemd-inhibit` on Linux. Where none is available
//! the assertion reports itself as inactive rather than pretending.

use std::process::{Child, Command, Stdio};

/// What a caller is asking the system not to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Assertion {
    /// Stop the machine idle-sleeping. The screen may still turn off.
    PreventIdleSleep,
    /// Additionally keep the display awake. For a task the user is watching.
    PreventDisplaySleep,
    /// Stop sleep even when the lid closes. macOS only; elsewhere this
    /// degrades to `PreventIdleSleep` rather than failing.
    PreventSystemSleep,
}

impl Assertion {
    pub fn label(&self) -> &'static str {
        match self {
            Assertion::PreventIdleSleep => "idle sleep",
            Assertion::PreventDisplaySleep => "display sleep",
            Assertion::PreventSystemSleep => "system sleep",
        }
    }
}

/// A held assertion. Dropping it releases the hold.
///
/// RAII rather than an explicit `release()`: an agent run can end by returning,
/// by throwing, or by being interrupted, and only a destructor covers all
/// three. A leaked assertion keeps a laptop awake until it is rebooted, which
/// the user would blame on the battery rather than on this.
pub struct PowerAssertion {
    child: Option<Child>,
    kind: Assertion,
    active: bool,
    reason: String,
}

impl PowerAssertion {
    /// Whether the hold is actually in force.
    ///
    /// False on a platform with no mechanism available. Callers should report
    /// this rather than assume — telling a user their machine will stay awake
    /// when it will not is worse than saying nothing.
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn kind(&self) -> Assertion {
        self.kind
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// Releases early. Idempotent; `drop` calls this too.
    pub fn release(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            // Reaped, or the helper stays a zombie for the life of the process
            // — over a long session that is one per assertion taken.
            let _ = child.wait();
        }
        self.active = false;
    }
}

impl Drop for PowerAssertion {
    fn drop(&mut self) {
        self.release();
    }
}

/// Takes an assertion for the duration of some work.
///
/// `reason` is shown by the OS in its own power UI on macOS and Linux, so it
/// should name the work rather than the program: "running tests" tells a user
/// looking at `pmset -g assertions` something useful; "jean" does not.
pub fn prevent_sleep(kind: Assertion, reason: &str) -> PowerAssertion {
    let child = spawn_helper(kind, reason);

    PowerAssertion {
        active: child.is_some(),
        child,
        kind,
        reason: reason.to_string(),
    }
}

#[cfg(target_os = "macos")]
fn spawn_helper(kind: Assertion, reason: &str) -> Option<Child> {
    // `caffeinate` holds the assertion for as long as it runs, so it is kept
    // alive rather than called once.
    let flag = match kind {
        Assertion::PreventIdleSleep => "-i",
        Assertion::PreventDisplaySleep => "-d",
        Assertion::PreventSystemSleep => "-s",
    };

    Command::new("caffeinate")
        .args([flag, "-w", &std::process::id().to_string()])
        .arg("-r")
        .arg(reason)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(target_os = "windows")]
fn spawn_helper(kind: Assertion, _reason: &str) -> Option<Child> {
    // ES_CONTINUOUS (0x80000000) makes the state persist until cleared, which
    // happens when this helper process exits.
    const CONTINUOUS: u32 = 0x8000_0000;
    const SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const DISPLAY_REQUIRED: u32 = 0x0000_0002;

    let flags = CONTINUOUS
        | SYSTEM_REQUIRED
        | match kind {
            Assertion::PreventDisplaySleep => DISPLAY_REQUIRED,
            _ => 0,
        };

    // A helper that sets the state and then sleeps: the flag is per-thread, so
    // it lives exactly as long as this process does.
    let script = format!(
        "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] \
         public static extern uint SetThreadExecutionState(uint e);'; \
         [W.P]::SetThreadExecutionState({flags}) | Out-Null; \
         while ($true) {{ Start-Sleep -Seconds 60 }}"
    );

    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_helper(kind: Assertion, reason: &str) -> Option<Child> {
    let what = match kind {
        Assertion::PreventDisplaySleep => "idle:sleep",
        _ => "sleep",
    };

    Command::new("systemd-inhibit")
        .args([
            &format!("--what={what}"),
            "--who=jean",
            &format!("--why={reason}"),
            "--mode=block",
            // Something must be run for the inhibitor to hold; `sleep infinity`
            // is the conventional placeholder and costs nothing.
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(not(any(unix, target_os = "windows")))]
fn spawn_helper(_kind: Assertion, _reason: &str) -> Option<Child> {
    None
}

/// Whether this platform can hold an assertion at all.
///
/// Checked by looking for the tool rather than by taking an assertion and
/// releasing it, so a caller can report the capability without side effects.
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    let probe = Command::new("caffeinate").arg("-h").output();

    #[cfg(target_os = "windows")]
    let probe = Command::new("powershell").args(["-NoProfile", "-Command", "exit 0"]).output();

    #[cfg(all(unix, not(target_os = "macos")))]
    let probe = Command::new("systemd-inhibit").arg("--help").output();

    #[cfg(not(any(unix, target_os = "windows")))]
    let probe: Result<std::process::Output, std::io::Error> =
        Err(std::io::Error::other("unsupported platform"));

    probe.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_assertion_names_itself() {
        assert_eq!(Assertion::PreventIdleSleep.label(), "idle sleep");
        assert_eq!(Assertion::PreventDisplaySleep.label(), "display sleep");
        assert_eq!(Assertion::PreventSystemSleep.label(), "system sleep");
    }

    #[test]
    fn taking_and_releasing_does_not_panic() {
        let mut assertion = prevent_sleep(Assertion::PreventIdleSleep, "running the test suite");

        // `is_active` is allowed to be false — a CI container has no power
        // daemon. What must hold is that the call is safe either way, and that
        // the assertion reports honestly rather than claiming a hold it lacks.
        let _ = assertion.is_active();
        assert_eq!(assertion.kind(), Assertion::PreventIdleSleep);
        assert_eq!(assertion.reason(), "running the test suite");

        assertion.release();
        assert!(!assertion.is_active());
    }

    #[test]
    fn releasing_twice_is_safe() {
        // `drop` calls `release` as well, so the second call always happens.
        let mut assertion = prevent_sleep(Assertion::PreventIdleSleep, "test");
        assertion.release();
        assertion.release();
        assert!(!assertion.is_active());
    }

    #[test]
    fn dropping_releases() {
        // The property the RAII design exists for: a run that ends by throwing
        // still gives the assertion back.
        {
            let _held = prevent_sleep(Assertion::PreventIdleSleep, "scoped work");
        }
        // Reaching here without a hang or a panic is the assertion.
    }

    #[test]
    fn availability_answers_without_taking_a_hold() {
        // Must not panic, and must not leave an assertion behind.
        let _ = available();
    }
}
