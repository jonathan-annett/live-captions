import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionSegment } from "@captions/protocol";
import {
  clearLastRoom,
  clearSession,
  loadLastRoom,
  loadSession,
  saveLastRoom,
  saveSession,
  type LastRoom,
  type PersistedSession,
} from "./session.js";

class MemStorage {
  private m = new Map<string, string>();
  throwOnSet = false;
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new DOMException("quota", "QuotaExceededError");
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

let mem: MemStorage;
beforeEach(() => {
  mem = new MemStorage();
  vi.stubGlobal("localStorage", mem);
});
afterEach(() => vi.unstubAllGlobals());

const seg = (id: string): CaptionSegment => ({ id, text: id, start: 0, end: 1 });

const base = (over: Partial<PersistedSession> = {}): PersistedSession => ({
  roomId: "r1",
  publishToken: "tok",
  roomBase: "https://v2.caption.guru",
  joinUrl: "https://v2.caption.guru/room?r1",
  model: "onnx-community/whisper-small.en",
  deviceId: "",
  startedAt: Date.now(),
  updatedAt: Date.now(),
  finals: [seg("a"), seg("b")],
  ...over,
});

describe("session recovery persistence", () => {
  it("round-trips a fresh record", () => {
    saveSession(base());
    const got = loadSession();
    expect(got?.roomId).toBe("r1");
    expect(got?.publishToken).toBe("tok");
    expect(got?.finals.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("drops (and clears) a record older than the retention window", () => {
    saveSession(base({ updatedAt: Date.now() - 31 * 60 * 1000 }));
    expect(loadSession()).toBeNull();
    expect(mem.getItem("cg.session")).toBeNull(); // expired record is purged
  });

  it("rejects a record missing required fields", () => {
    mem.setItem("cg.session", JSON.stringify({ roomId: "r1" })); // no token/model
    expect(loadSession()).toBeNull();
  });

  it("falls back to dropping the transcript when storage is full", () => {
    // Fail the first (with-finals) write; allow the retry (without finals).
    let calls = 0;
    const realSet = mem.setItem.bind(mem);
    mem.setItem = (k: string, v: string) => {
      if (calls++ === 0) throw new DOMException("quota", "QuotaExceededError");
      realSet(k, v);
    };
    saveSession(base());
    const got = loadSession();
    expect(got?.roomId).toBe("r1"); // room state survived
    expect(got?.finals).toEqual([]); // transcript sacrificed to fit
  });

  it("clearSession removes the record", () => {
    saveSession(base());
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

const lastRoom = (over: Partial<LastRoom> = {}): LastRoom => ({
  roomId: "r1",
  publishToken: "tok",
  roomBase: "https://v2.caption.guru",
  joinUrl: "https://v2.caption.guru/room?r1",
  startedAt: Date.now(),
  stoppedAt: Date.now(),
  ...over,
});

describe("last stopped room", () => {
  it("round-trips a recently stopped room", () => {
    saveLastRoom(lastRoom());
    expect(loadLastRoom()?.roomId).toBe("r1");
    expect(loadLastRoom()?.publishToken).toBe("tok");
  });

  it("drops a room stopped beyond the offer window", () => {
    saveLastRoom(lastRoom({ stoppedAt: Date.now() - 4 * 60 * 60 * 1000 }));
    expect(loadLastRoom()).toBeNull();
  });

  it("clears the remembered room", () => {
    saveLastRoom(lastRoom());
    clearLastRoom();
    expect(loadLastRoom()).toBeNull();
  });
});
