// Persistent QR PNG file, via the File System Access API (Chromium only).
//
// The operator can pick a real file on disk; we remember its handle so every
// room (re)start rewrites the same file — an OBS/PowerPoint image source that
// auto-refreshes then always shows the current room's join QR.
//
// FileSystemFileHandle is structured-cloneable to IndexedDB (but NOT to
// localStorage), so the handle survives reloads via a tiny IDB store. All File
// System Access typing is contained here so the Svelte component stays clean;
// these interfaces aren't in the standard DOM lib yet.

type FsPermissionState = "granted" | "denied" | "prompt";

interface FsWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface QrFileHandle {
  readonly name: string;
  createWritable(): Promise<FsWritable>;
  queryPermission?(desc: { mode: "read" | "readwrite" }): Promise<FsPermissionState>;
  requestPermission?(desc: { mode: "read" | "readwrite" }): Promise<FsPermissionState>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

type WindowWithPicker = Window & {
  showSaveFilePicker?(opts?: SaveFilePickerOptions): Promise<QrFileHandle>;
};

/** True only where the File System Access save picker exists (Chromium). */
export function fsAccessSupported(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

// --- IndexedDB handle store (db `cg-fs`, store `handles`, key `qrPng`) -------
const DB_NAME = "cg-fs";
const STORE = "handles";
const KEY = "qrPng";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** The remembered handle, or null if none / storage unavailable. */
export async function loadQrPngHandle(): Promise<QrFileHandle | null> {
  try {
    return (await withStore<QrFileHandle | undefined>("readonly", (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

/** Prompt for a save file and remember its handle. Null on cancel/unsupported. */
export async function pickQrPngHandle(): Promise<QrFileHandle | null> {
  const w = window as WindowWithPicker;
  if (!w.showSaveFilePicker) return null;
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: "caption-room-qr.png",
      types: [{ description: "PNG", accept: { "image/png": [".png"] } }],
    });
    try {
      await withStore("readwrite", (s) => s.put(handle, KEY));
    } catch {
      /* IDB disabled — the handle still works for this session */
    }
    return handle;
  } catch {
    // User cancelled the picker, or the browser refused — no-op.
    return null;
  }
}

/** Forget the remembered handle. */
export async function clearQrPngHandle(): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {
    /* no-op */
  }
}

/**
 * Write `blob` to the handle, requesting readwrite permission first (query,
 * then request). Returns false (never throws) on permission denial or error.
 */
export async function writeQrPng(handle: QrFileHandle, blob: Blob): Promise<boolean> {
  try {
    if (handle.queryPermission && handle.requestPermission) {
      let state = await handle.queryPermission({ mode: "readwrite" });
      if (state !== "granted") state = await handle.requestPermission({ mode: "readwrite" });
      if (state !== "granted") return false;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    console.warn("[qr] persistent file write failed", err);
    return false;
  }
}
