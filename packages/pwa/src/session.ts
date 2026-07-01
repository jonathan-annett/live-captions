import type { CaptionSegment } from "@captions/protocol";

/**
 * Operator session recovery: persist just enough to rebuild a live captioning
 * session (with its audience room) after a page refresh. The publish token is a
 * secret, but this is the operator's own device and same-origin storage.
 *
 * Recovery is only offered while the record is fresh — capped to the room's
 * Durable Object retention (30 min), so a stale record never resurrects a room
 * the edge has already pruned.
 */

const KEY = "cg.session";
/** Matches the CaptionRoom DO's rolling retention (packages/room/src/room.ts). */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface PersistedSession {
  roomId: string;
  publishToken: string;
  /** origin the room lives on (may differ from the page origin) */
  roomBase: string;
  /** audience join URL (for the QR + link on recovery) */
  joinUrl: string;
  model: string;
  deviceId: string;
  startedAt: number;
  updatedAt: number;
  /** transcript snapshot; best-effort (dropped first if storage is full) */
  finals: CaptionSegment[];
}

export function saveSession(s: PersistedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota — almost always the transcript. Retry without it so the room +
    // engine state still recover; the DO backfills the transcript on reconnect.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...s, finals: [] }));
    } catch {
      /* storage disabled / private mode */
    }
  }
}

export function loadSession(): PersistedSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as PersistedSession;
    if (!s?.roomId || !s.publishToken || !s.model) return null;
    const stamp = s.updatedAt ?? s.startedAt ?? 0;
    if (Date.now() - stamp > MAX_AGE_MS) {
      clearSession();
      return null;
    }
    if (!Array.isArray(s.finals)) s.finals = [];
    return s;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
