export interface DownloadProgress {
  percent: number | null;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface InstallProgress {
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  log: string;
  operation?: "update";
  requestId?: string;
}

// @lat: [[desktop-updates#Progress evidence]]
export function measuredDownloadProgress(progress: {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): DownloadProgress {
  const nonnegative = (value: number | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const total =
    nonnegative(progress.total) && progress.total > 0
      ? progress.total
      : undefined;
  return {
    percent:
      total !== undefined &&
      nonnegative(progress.percent) &&
      progress.percent <= 100
        ? progress.percent
        : null,
    ...(nonnegative(progress.transferred)
      ? { transferred: progress.transferred }
      : {}),
    ...(total !== undefined ? { total } : {}),
    ...(nonnegative(progress.bytesPerSecond)
      ? { bytesPerSecond: progress.bytesPerSecond }
      : {}),
  };
}
