/**
 * Transcript export from finalized caption segments. Format logic lives here
 * (consumed by the PWA); the desktop build mirrors it in export.py.
 */
import type { CaptionSegment } from "./index.js";

export type ExportFormat = "txt" | "srt" | "vtt";

export function toPlainText(segments: CaptionSegment[]): string {
  return segments.map((s) => s.text).join("\n") + "\n";
}

export function toSRT(segments: CaptionSegment[]): string {
  return (
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${fmtTime(s.start, ",")} --> ${fmtTime(s.end, ",")}\n${s.text}\n`,
      )
      .join("\n")
  );
}

export function toVTT(segments: CaptionSegment[]): string {
  return (
    "WEBVTT\n\n" +
    segments
      .map(
        (s) => `${fmtTime(s.start, ".")} --> ${fmtTime(s.end, ".")}\n${s.text}\n`,
      )
      .join("\n")
  );
}

export function exportTranscript(
  segments: CaptionSegment[],
  format: ExportFormat,
): { body: string; mime: string; filename: string } {
  switch (format) {
    case "srt":
      return { body: toSRT(segments), mime: "application/x-subrip", filename: "transcript.srt" };
    case "vtt":
      return { body: toVTT(segments), mime: "text/vtt", filename: "transcript.vtt" };
    case "txt":
    default:
      return { body: toPlainText(segments), mime: "text/plain", filename: "transcript.txt" };
  }
}

function fmtTime(totalSeconds: number, sep: "," | "."): string {
  // Round to whole milliseconds first to avoid float truncation (e.g. 2.4s).
  const totalMs = Math.round(Math.max(0, totalSeconds) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ms, 3)}`;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}
