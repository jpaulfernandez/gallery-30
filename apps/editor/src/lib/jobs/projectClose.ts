import { useBookStore } from '../../store/book';
import { cancelProjectJobs } from '../../store/jobs';

/**
 * Plan 09: closing a project (Close, Delete, or opening another one) cancels its queued and running jobs (renders,
 * denoise and the publish started for it), and the jobs bar says so. Installed once at startup; returns the unsubscribe.
 */
export function installProjectJobCancel(): () => void {
  return useBookStore.subscribe((s, prev) => {
    if (prev.projectId && s.projectId !== prev.projectId) cancelProjectJobs(prev.projectId, prev.book?.title);
  });
}
