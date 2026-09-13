//! Process ownership shared by local rendering engines.
#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::io;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_user_time: i64,
        job_user_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub struct ProcessTree(*mut c_void);
    // 独占内核句柄可在线程之间移动；这里只通过所有者 Drop 关闭。
    unsafe impl Send for ProcessTree {}
    impl ProcessTree {
        pub fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let limits = ExtendedLimits {
                basic: BasicLimits {
                    flags: 0x0000_2000,
                    ..Default::default()
                },
                ..Default::default()
            };
            if unsafe {
                SetInformationJobObject(
                    handle,
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("动画子进程已退出"))?;
            if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
#[cfg(windows)]
pub(crate) use windows_job::ProcessTree;

#[cfg(not(windows))]
pub(crate) struct ProcessTree;
#[cfg(not(windows))]
impl ProcessTree {
    pub(crate) fn attach(_child: &tokio::process::Child) -> std::io::Result<Self> {
        Ok(Self)
    }
}
// 非 Windows 平台没有 OS Job 对象可回收；空 Drop 让调用点
// drop(process_tree) 的意图保持一致，并通过 clippy::drop_non_drop。
#[cfg(not(windows))]
impl Drop for ProcessTree {
    fn drop(&mut self) {}
}
