//! Process ownership shared by local rendering engines.
//!
//! Windows 用内核 Job 对象（`KILL_ON_JOB_CLOSE`）回收整棵子进程树；
//! 其他平台没有等价的 OS 对象，改用「独立进程组 + `killpg`」达到同样效果：
//! 渲染引擎（node / ffmpeg / Chrome headless-shell / Blender）被放进各自的
//! 进程组，取消、超时、应用退出时整组一起回收，不会残留孤儿进程。
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
        /// Job 对象在 spawn 之后绑定即可，spawn 前无需设置。
        pub(crate) fn configure(_command: &mut tokio::process::Command) {}

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

        /// Job 句柄带 `KILL_ON_JOB_CLOSE`：随所有者 Drop 或应用退出自动回收，
        /// 因此退出钩子无需额外处理。
        pub(crate) fn kill_all() {}
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

#[cfg(unix)]
mod unix_group {
    use std::collections::HashSet;
    use std::io;
    use std::sync::{Mutex, OnceLock};

    /// 仍登记在册的活跃进程组，供应用退出时兜底回收。
    fn live_groups() -> &'static Mutex<HashSet<i32>> {
        static LIVE_GROUPS: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
        LIVE_GROUPS.get_or_init(|| Mutex::new(HashSet::new()))
    }

    pub(crate) struct ProcessTree {
        pgid: i32,
    }

    impl ProcessTree {
        /// 必须在 `spawn` **之前**调用：让子进程自成进程组（pgid == pid）。
        ///
        /// 没有这一步，子进程会留在应用自己的进程组里，`killpg` 就会连应用
        /// 一起杀掉；`attach` 里的 `getpgid` 校验是这条不变量的第二道保险。
        pub(crate) fn configure(command: &mut tokio::process::Command) {
            command.process_group(0);
        }

        pub(crate) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("动画子进程已退出"))?;
            let pid = i32::try_from(pid).map_err(|_| io::Error::other("子进程 pid 超出范围"))?;
            // 只有确认子进程真的独立成组才登记。否则 killpg 会打到自己所在的
            // 进程组（即整个应用），属于不可接受的误杀，宁可放弃回收。
            let pgid = unsafe { libc::getpgid(pid) };
            if pgid != pid {
                return Err(io::Error::other("子进程未独立成组，已跳过进程组回收"));
            }
            live_groups()
                .lock()
                .expect("process group registry poisoned")
                .insert(pgid);
            Ok(Self { pgid })
        }

        /// 应用退出时的兜底回收：杀掉所有仍登记在册的进程组。
        pub(crate) fn kill_all() {
            let groups: Vec<i32> = live_groups()
                .lock()
                .expect("process group registry poisoned")
                .drain()
                .collect();
            for pgid in groups {
                // SAFETY: pgid 来自 attach 校验过的独立进程组；组不存在时
                // killpg 只返回 ESRCH，无副作用。
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            live_groups()
                .lock()
                .expect("process group registry poisoned")
                .remove(&self.pgid);
            // SIGKILL 整组：Chrome headless-shell、ffmpeg 等孙进程一并回收。
            // SAFETY: 同 kill_all；组已空时返回 ESRCH。
            unsafe {
                libc::killpg(self.pgid, libc::SIGKILL);
            }
        }
    }
}
#[cfg(unix)]
pub(crate) use unix_group::ProcessTree;

/// 既不是 Windows 也不是 Unix（例如 wasm）时的占位实现。
#[cfg(not(any(windows, unix)))]
pub(crate) struct ProcessTree;
#[cfg(not(any(windows, unix)))]
impl ProcessTree {
    pub(crate) fn configure(_command: &mut tokio::process::Command) {}
    pub(crate) fn attach(_child: &tokio::process::Child) -> std::io::Result<Self> {
        Ok(Self)
    }
    pub(crate) fn kill_all() {}
}
// 空 Drop 让调用点 `drop(process_tree)` 的意图保持一致，
// 并通过 clippy::drop_non_drop。
#[cfg(not(any(windows, unix)))]
impl Drop for ProcessTree {
    fn drop(&mut self) {}
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::Duration;

    /// 取消 / 超时 / 退出依赖「整组回收」：连孙进程（Chrome headless-shell、
    /// ffmpeg）也必须一起结束，否则每取消一次渲染都会留下常驻孤儿进程。
    ///
    /// 该用例在 `quality` 作业的 Linux 上就会执行，因此这条非 Windows 逻辑
    /// 不再只靠人工在苹果机器上验证。Windows 由 Job 对象保证，不走这里。
    #[tokio::test]
    async fn dropping_the_tree_reaps_grandchildren_too() {
        let directory = tempfile::tempdir().unwrap();
        let heartbeat = directory.path().join("beat");
        // 孙进程持续追加心跳：只要它活着，文件内容就会不断变化。
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            .arg("while true; do echo tick >> \"$1\"; sleep 0.2; done")
            .arg("sh")
            .arg(&heartbeat)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        ProcessTree::configure(&mut command);
        let mut child = command.spawn().expect("spawn 心跳进程");
        let tree = ProcessTree::attach(&child).expect("子进程应自成进程组");

        // 等心跳真正开始跳动（最多 5 秒），避免慢机器上的启动抖动被误判成失败。
        let mut started = false;
        for _ in 0..50 {
            if std::fs::metadata(&heartbeat).is_ok_and(|metadata| metadata.len() > 0) {
                started = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(started, "心跳未启动，用例前提不成立");

        drop(tree);
        let _ = child.wait().await;

        let after_drop = std::fs::read(&heartbeat).unwrap_or_default();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let later = std::fs::read(&heartbeat).unwrap_or_default();
        assert_eq!(
            after_drop, later,
            "进程组回收后孙进程仍在写心跳：孤儿进程未被清理",
        );
    }
    /// `attach` 必须拒绝不在独立进程组里的子进程。
    ///
    /// 没有这条校验，`killpg` 会打中应用自己所在的进程组——把整个应用杀掉。
    #[tokio::test]
    async fn attach_rejects_a_child_that_did_not_get_its_own_group() {
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 5")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 故意不调用 configure：子进程留在应用自己的进程组里。
        let mut child = command.spawn().expect("spawn sh");
        assert!(
            ProcessTree::attach(&child).is_err(),
            "未独立成组的子进程必须被拒绝，否则 killpg 会误杀整个应用",
        );
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}
