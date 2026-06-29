// Phase-A smoke test for the CaptionRoom Worker.
//
// Drives a real publisher + two subscribers against a running `wrangler dev`
// (Node 24 ships global fetch + WebSocket, so no deps). Asserts: fan-out to all
// subscribers, history replay to a late joiner, and publish-token rejection.
//
//   pnpm --filter @captions/room dev      # terminal 1
//   pnpm --filter @captions/room verify   # terminal 2
//
// Override the target with ROOM_URL (default http://127.0.0.1:8787).

const BASE = process.env.ROOM_URL ?? "http://127.0.0.1:8787";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
};

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });

// Collect parsed messages; `waitFor` resolves once a predicate matches.
const collector = (ws) => {
  const seen = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    seen.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    seen,
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const hit = seen.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
  };
};

async function main() {
  // 1. create a room
  const res = await fetch(`${BASE}/r/new`, { method: "POST" });
  if (!res.ok) throw new Error(`/r/new -> ${res.status}`);
  const room = await res.json();
  ok(typeof room.id === "string" && room.id.length > 0, `created room ${room.id}`);
  ok(typeof room.publishToken === "string", "got a publish token");

  // 2. two subscribers connect
  const sub1 = collector(await open(room.subscribeUrl));
  const sub2 = collector(await open(room.subscribeUrl));
  ok(true, "two subscribers connected");

  // 3. publisher connects and emits a final segment
  const pub = await open(room.publishUrl);
  ok(true, "publisher connected with token");

  const segment = {
    id: "seg-1",
    text: "hello audience",
    start: 0.0,
    end: 1.2,
  };
  pub.send(JSON.stringify({ type: "final", segment }));

  // 4. both subscribers receive the fan-out
  const r1 = await sub1.waitFor((m) => m.type === "final" && m.segment.id === "seg-1");
  const r2 = await sub2.waitFor((m) => m.type === "final" && m.segment.id === "seg-1");
  ok(r1.segment.text === "hello audience", "subscriber 1 received the final");
  ok(r2.segment.text === "hello audience", "subscriber 2 received the final");

  // 5. a late joiner is replayed history
  const sub3 = collector(await open(room.subscribeUrl));
  const hist = await sub3.waitFor((m) => m.type === "history");
  ok(
    Array.isArray(hist.segments) && hist.segments.some((s) => s.id === "seg-1"),
    "late joiner received history with the segment",
  );

  // 6. upsert-by-id: re-emitting the same id replaces in place (no duplicate)
  pub.send(
    JSON.stringify({ type: "final", segment: { ...segment, text: "hello, audience!" } }),
  );
  await sub1.waitFor((m) => m.type === "final" && m.segment.text === "hello, audience!");
  const sub4 = collector(await open(room.subscribeUrl));
  const hist2 = await sub4.waitFor((m) => m.type === "history");
  const matches = hist2.segments.filter((s) => s.id === "seg-1");
  ok(matches.length === 1, "upsert-by-id kept a single segment");
  ok(matches[0]?.text === "hello, audience!", "history reflects the correction");

  // 7. publish with a bad token is rejected
  let rejected = false;
  try {
    await open(room.publishUrl.replace(room.publishToken, "deadbeef"));
  } catch {
    rejected = true;
  }
  ok(rejected, "publish with a bad token was rejected");

  for (const ws of [sub1, sub2, sub3, sub4]) {/* collectors hold no close */}
  pub.close();

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
