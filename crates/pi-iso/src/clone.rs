//! Copy-on-write cloning of single files: the new file shares the old one's
//! blocks until either is written, so a view of a large tree costs metadata
//! rather than a second copy of every byte.
//!
//! - macOS: `clonefile(2)`, on APFS.
//! - Linux: the `FICLONE` ioctl, on btrfs, XFS (reflink=1), and bcachefs.
//! - Windows: `FSCTL_DUPLICATE_EXTENTS_TO_FILE`, ReFS block cloning — what a
//!   Dev Drive is formatted with.
//!
//! Each is one system call, declared here rather than pulled in through a
//! crate. When the file system says no — NTFS, ext4, a copy across volumes —
//! the file is copied instead, and the [`Cloner`] stops asking, so a tree of
//! thousands of files on ext4 does not make thousands of failing calls.

use std::fs;
use std::io;
use std::path::Path;

/// What the platform's cloning is called, or `None` where there is none.
pub const METHOD: Option<&str> = if cfg!(target_os = "macos") {
    Some("apfs-clonefile")
} else if cfg!(target_os = "linux") {
    Some("reflink")
} else if cfg!(windows) {
    Some("refs-block-clone")
} else {
    None
};

/// Clones or copies files into a view, and counts which it did.
#[derive(Debug)]
pub struct Cloner {
    enabled: bool,
    pub cloned: usize,
    pub copied: usize,
}

impl Default for Cloner {
    fn default() -> Self {
        Cloner { enabled: METHOD.is_some() && std::env::var_os("JEAN_ISO_NO_CLONE").is_none(), cloned: 0, copied: 0 }
    }
}

impl Cloner {
    /// Puts `source` at `target`: a clone when the file system can make one,
    /// a copy otherwise. An existing `target` is refused, never replaced.
    pub fn place(&mut self, source: &Path, target: &Path) -> Result<(), String> {
        if target.exists() {
            return Err(format!("{}: already exists", target.display()));
        }
        if self.enabled {
            match clone(source, target) {
                Ok(()) => {
                    self.cloned += 1;
                    return Ok(());
                }
                Err(_) => {
                    // Whatever the failed clone left is ours to remove: the
                    // target did not exist before it.
                    let _ = fs::remove_file(target);
                    // The first refusal is the file system's answer for the
                    // whole tree; a later one is that file's own trouble.
                    if self.cloned == 0 {
                        self.enabled = false;
                    }
                }
            }
        }
        fs::copy(source, target).map_err(|error| format!("{}: {error}", source.display()))?;
        self.copied += 1;
        Ok(())
    }

    /// The method that filled the view: the clone method when any file was
    /// cloned, `copy` otherwise.
    pub fn method(&self) -> &'static str {
        match METHOD {
            Some(method) if self.cloned > 0 => method,
            _ => "copy",
        }
    }
}

#[cfg(target_os = "macos")]
fn clone(source: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn clonefile(src: *const c_char, dst: *const c_char, flags: u32) -> c_int;
    }
    let from = CString::new(source.as_os_str().as_bytes())?;
    let to = CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both are valid NUL-terminated paths for the length of the call.
    if unsafe { clonefile(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn clone(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::raw::{c_int, c_ulong};
    use std::os::unix::io::AsRawFd;

    extern "C" {
        fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    }
    /// `_IOW(0x94, 9, int)`.
    const FICLONE: c_ulong = 0x4004_9409;

    let from = fs::File::open(source)?;
    let to = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
    // SAFETY: both descriptors are open for the length of the call.
    if unsafe { ioctl(to.as_raw_fd(), FICLONE, from.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    fs::set_permissions(target, from.metadata()?.permissions())
}

#[cfg(windows)]
fn clone(source: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;

    #[repr(C)]
    struct DuplicateExtentsData {
        file_handle: *mut c_void,
        source_offset: i64,
        target_offset: i64,
        byte_count: i64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            input: *mut c_void,
            input_size: u32,
            output: *mut c_void,
            output_size: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn GetVolumeInformationByHandleW(
            file: *mut c_void,
            volume_name: *mut u16,
            volume_name_size: u32,
            serial: *mut u32,
            max_component: *mut u32,
            flags: *mut u32,
            file_system_name: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
        fn GetDiskFreeSpaceW(
            root: *const u16,
            sectors_per_cluster: *mut u32,
            bytes_per_sector: *mut u32,
            free_clusters: *mut u32,
            total_clusters: *mut u32,
        ) -> i32;
    }
    const FSCTL_DUPLICATE_EXTENTS_TO_FILE: u32 = 0x0009_8344;
    const FILE_SUPPORTS_BLOCK_REFCOUNTING: u32 = 0x0800_0000;

    let from = fs::File::open(source)?;
    let mut flags = 0u32;
    // SAFETY: the handle is open; each out pointer is valid, or null with a zero size.
    let known = unsafe {
        GetVolumeInformationByHandleW(from.as_raw_handle(), null_mut(), 0, null_mut(), null_mut(), &mut flags, null_mut(), 0)
    };
    if known == 0 || flags & FILE_SUPPORTS_BLOCK_REFCOUNTING == 0 {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "the volume has no block cloning"));
    }

    // Cloned ranges start and end on cluster boundaries: the file is
    // extended to the next one, cloned, and cut back to its length.
    let absolute = fs::canonicalize(source)?;
    let text = absolute.to_string_lossy();
    let path = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let root: Vec<u16> = std::ffi::OsStr::new(&path[..path.len().min(3)]).encode_wide().chain(Some(0)).collect();
    let (mut sectors, mut bytes, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
    // SAFETY: `root` is NUL-terminated; the out pointers are valid.
    let measured = unsafe { GetDiskFreeSpaceW(root.as_ptr(), &mut sectors, &mut bytes, &mut free, &mut total) } != 0;
    let cluster = if measured { u64::from(sectors) * u64::from(bytes) } else { 64 * 1024 }.max(4096);

    let length = from.metadata()?.len();
    let to = fs::OpenOptions::new().read(true).write(true).create_new(true).open(target)?;
    let aligned = length.div_ceil(cluster) * cluster;
    to.set_len(aligned)?;
    let mut offset = 0u64;
    while offset < aligned {
        // Under 4 GiB per call, on a cluster boundary.
        let count = (aligned - offset).min((1u64 << 31) / cluster * cluster);
        let mut data = DuplicateExtentsData {
            file_handle: from.as_raw_handle(),
            source_offset: offset as i64,
            target_offset: offset as i64,
            byte_count: count as i64,
        };
        let mut returned = 0u32;
        // SAFETY: `data` lives for the call and holds the open source handle.
        let done = unsafe {
            DeviceIoControl(
                to.as_raw_handle(),
                FSCTL_DUPLICATE_EXTENTS_TO_FILE,
                (&mut data as *mut DuplicateExtentsData).cast(),
                std::mem::size_of::<DuplicateExtentsData>() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        };
        if done == 0 {
            return Err(io::Error::last_os_error());
        }
        offset += count;
    }
    to.set_len(length)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn clone(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no file cloning on this platform"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_arrives_whole_whichever_way_it_came() {
        let dir = std::env::temp_dir().join(format!("pi-iso-clone-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.bin");
        let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&source, &content).unwrap();

        let mut cloner = Cloner::default();
        cloner.place(&source, &dir.join("one.bin")).unwrap();
        cloner.place(&source, &dir.join("two.bin")).unwrap();
        assert_eq!(fs::read(dir.join("one.bin")).unwrap(), content);
        assert_eq!(fs::read(dir.join("two.bin")).unwrap(), content);
        assert_eq!(cloner.cloned + cloner.copied, 2);

        // Writing the copy leaves the original alone, cloned or not.
        fs::write(dir.join("one.bin"), b"changed").unwrap();
        assert_eq!(fs::read(&source).unwrap(), content);

        // An existing target is refused and left as it was.
        assert!(cloner.place(&source, &dir.join("one.bin")).is_err());
        assert_eq!(fs::read(dir.join("one.bin")).unwrap(), b"changed");
        let _ = fs::remove_dir_all(&dir);
    }
}
