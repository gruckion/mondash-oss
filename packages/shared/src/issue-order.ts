/** Linear's state type is authoritative; older snapshots fall back to their visible status. */
export function issueStateRank(statusType?: string, status?: string): number {
  if (statusType) return statusType === "started" ? 0 : statusType === "unstarted" ? 1 : 2;
  const label = status?.trim().toLowerCase();
  return label === "in progress" || label === "started" ? 0 : label === "todo" || label === "to do" ? 1 : 2;
}
