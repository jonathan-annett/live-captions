import { mount } from "svelte";
import { RoomSource, Viewer } from "@captions/display";

// Clean audience join page, served at /room. The QR encodes /room?<id> (the
// bare room id as the query), so the URL stays short and scannable. We also
// accept the explicit form /room?room=<id>&base=<origin> for cross-origin rooms.
const raw = location.search.replace(/^\?/, "");
let roomId = "";
let base: string | undefined;
if (raw.includes("=")) {
  const params = new URLSearchParams(raw);
  roomId = params.get("room") ?? "";
  base = params.get("base") ?? undefined;
} else {
  roomId = decodeURIComponent(raw);
}

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

const source = roomId ? RoomSource.forRoom(roomId, base) : undefined;

export default mount(Viewer, {
  target,
  props: source ? { source } : {},
});
