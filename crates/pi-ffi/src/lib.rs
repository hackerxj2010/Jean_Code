//! # pi-ffi
//!
//! The Rust core as a library loaded into the Jean process, for callers that
//! have to answer synchronously.
//!
//! The `pi-natives` binary is the main road in: one long-lived child, one JSON
//! line per call, a third of a millisecond each. But it is asynchronous, and
//! the memory backend's interface is not — `recall` is called while a prompt
//! is being built. Run synchronously, the binary costs a process start per
//! call, about 80 ms on Windows, twice per prompt. Through this library the
//! same call takes microseconds.
//!
//! The protocol is the binary's, unchanged: a JSON request in, a JSON response
//! out, dispatched by the same [`handlers::dispatch`]. Only the transport
//! differs, so anything that works over the pipe works here.
//!
//! Built with the workspace's `ffi` profile, which unwinds on panic: a panic
//! is caught at the boundary and returned as a failure, instead of aborting
//! the host process.

use pi_natives::handlers;
use pi_natives::ops::State;
use pi_natives::protocol;
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, OnceLock};

/// Shell sessions, views, and assertions made through this library, kept for
/// the life of the process as the binary keeps them for the life of the child.
static STATE: OnceLock<Mutex<State>> = OnceLock::new();

/// Answers one request line. Never panics across the boundary.
pub fn call(request: &str) -> String {
    let answered = catch_unwind(AssertUnwindSafe(|| {
        // A poisoned lock means an earlier call panicked mid-update; the state
        // it left is still better than refusing every call after it.
        let mut state = STATE
            .get_or_init(|| Mutex::new(State::default()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match protocol::Request::parse(request.trim()) {
            Ok(parsed) => handlers::dispatch(&parsed, &mut state),
            Err(message) => protocol::failure("", message),
        }
    }));
    answered.unwrap_or_else(|_| protocol::failure("", "the native call panicked".to_string()))
}

/// Answers one JSON request. The returned string is owned by the caller and
/// must be released with [`jean_native_free`].
///
/// # Safety
///
/// `request` must point to a NUL-terminated string that stays valid for the
/// duration of the call. It is read as UTF-8, lossily.
#[no_mangle]
pub unsafe extern "C" fn jean_native_call(request: *const c_char) -> *mut c_char {
    if request.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller guarantees a valid NUL-terminated string.
    let text = unsafe { CStr::from_ptr(request) }.to_string_lossy();
    let response = call(&text);
    // A response cannot contain NUL — it is JSON, which escapes it — but a
    // failure here must still not unwind.
    CString::new(response).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Releases a string returned by [`jean_native_call`].
///
/// # Safety
///
/// `response` must be null or a pointer returned by [`jean_native_call`] that
/// has not already been released.
#[no_mangle]
pub unsafe extern "C" fn jean_native_free(response: *mut c_char) {
    if !response.is_null() {
        // SAFETY: the pointer came from `CString::into_raw` in `jean_native_call`.
        drop(unsafe { CString::from_raw(response) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_through_the_c_boundary() {
        let request = CString::new(r#"{"id":"1","method":"ping","params":{}}"#).unwrap();
        // SAFETY: a valid NUL-terminated string, and the result is freed once.
        let response = unsafe { jean_native_call(request.as_ptr()) };
        assert!(!response.is_null());
        let text = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
        unsafe { jean_native_free(response) };
        assert!(text.contains("pong"), "{text}");
    }

    #[test]
    fn a_malformed_request_is_an_answer_not_a_crash() {
        assert!(call("not json").contains("\"ok\":false"));
    }

    #[test]
    fn memory_answers_synchronously() {
        let dir = std::env::temp_dir().join(format!("pi-ffi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("memory.log").to_string_lossy().replace('\\', "/");
        let stored = call(&format!(
            r#"{{"id":"1","method":"memory.remember","params":{{"path":"{log}","name":"n","text":"zebra facts"}}}}"#
        ));
        assert!(stored.contains("\"ok\":true"), "{stored}");
        let recalled = call(&format!(
            r#"{{"id":"2","method":"memory.recall","params":{{"path":"{log}","query":"zebra"}}}}"#
        ));
        assert!(recalled.contains("zebra facts"), "{recalled}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
