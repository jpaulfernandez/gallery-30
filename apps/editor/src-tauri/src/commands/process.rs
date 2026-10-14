//! Child processes the editor kills as a whole (workflow plan 16, the pattern of plans 14 and 15): the publish CLI runs
//! `tsx` → Node → Chromium, so killing only the first process would leave the rest writing files and holding the pipes
//! open. A child is started as the leader of its own process group (`in_own_group`) and killed with its group
//! (`kill_group`); `exit_signal` tells a crash by signal from a normal exit.

use std::process::{Child, Command, ExitStatus};

/// Start the child as the leader of a new process group, so `kill_group` reaches what it starts (Node, Chromium).
#[cfg(unix)]
pub fn in_own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
pub fn in_own_group(_cmd: &mut Command) {}

/// Kill `child` and every process of its group (it leads one, see `in_own_group`).
pub fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        // `kill -KILL -<pgid>`: the group's id is the leader's pid.
        let _ = Command::new("/bin/kill").args(["-KILL", &format!("-{}", child.id())]).status();
    }
    let _ = child.kill();
}

/// The signal that ended the process, if one did.
#[cfg(unix)]
pub fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}
