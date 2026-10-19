import { useEffect, useState } from "react";
import type { DownloadProgress } from "../../../../shared/update-progress";
import { useI18n } from "../useI18n";

const INACTIVITY_MS = 15000;

// @lat: [[desktop-updates#Progress evidence#Unknown and inactive download feedback]]
export function useUpdateDownloadText(
  progress: DownloadProgress | null,
  downloading: boolean,
): { title: string; detail: string; text: string } {
  const { t, locale } = useI18n();
  const [waiting, setWaiting] = useState(false);
  const transferred = progress?.transferred;
  const percent = progress?.percent;
  const total = progress?.total;
  useEffect(() => {
    if (!downloading) return;
    setWaiting(false);
    const deadline = setTimeout(() => setWaiting(true), INACTIVITY_MS);
    return () => clearTimeout(deadline);
  }, [downloading, transferred, percent, total]);

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const bytes = (value: number): string => {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const unit =
      value > 0
        ? Math.max(
            0,
            Math.min(Math.floor(Math.log2(value) / 10), units.length - 1),
          )
        : 0;
    return `${number.format(value / 1024 ** unit)} ${units[unit]}`;
  };
  const title = waiting
    ? t("common.waitingForDownloadProgress")
    : typeof percent === "number"
      ? t("common.downloading", { percent: number.format(percent) })
      : t("common.downloadingUnknown");
  const details: string[] = [];
  if (transferred !== undefined)
    details.push(
      total !== undefined
        ? `${bytes(transferred)} / ${bytes(total)}`
        : bytes(transferred),
    );
  if (!waiting && progress?.bytesPerSecond !== undefined)
    details.push(`${bytes(progress.bytesPerSecond)}/s`);
  const detail = details.join(" · ");
  return { title, detail, text: [title, detail].filter(Boolean).join(" · ") };
}
