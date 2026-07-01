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

// --- last stopped room ------------------------------------------------------
// When the operator stops a room we remember it, so they can reopen the SAME
// room id/token. The room's Durable Object keeps its token in persistent
// storage, so reconnecting resumes it (audience who kept the link rejoin; the
// transcript survives within the 30-min retention, empty after). Offered for a
// few hours, after which a "restart" would just be a bare empty room.

const LAST_ROOM_KEY = "cg.lastRoom";
const LAST_ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface LastRoom {
  roomId: string;
  publishToken: string;
  roomBase: string;
  joinUrl: string;
  /** when the room was originally created */
  startedAt: number;
  /** when the operator stopped it */
  stoppedAt: number;
}

export function saveLastRoom(r: LastRoom): void {
  try {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(r));
  } catch {
    /* storage disabled */
  }
}

export function loadLastRoom(): LastRoom | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as LastRoom;
    if (!r?.roomId || !r.publishToken) return null;
    if (Date.now() - (r.stoppedAt ?? 0) > LAST_ROOM_MAX_AGE_MS) {
      clearLastRoom();
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

export function clearLastRoom(): void {
  try {
    localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* ignore */
  }
}
