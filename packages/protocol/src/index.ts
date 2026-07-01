/**
 * Shared caption protocol — the single source of truth for messages exchanged
 * between an ASR engine (PWA in-browser, or desktop Python server) and the
 * display / control clients.
 *
 * Transport-agnostic: the same JSON flows over a BroadcastChannel (PWA) or a
 * WebSocket (desktop). All timestamps are **seconds relative to session start**.
 *
 * Captions form an append-only, timestamped log. `final` segments carry a
 * stable `id` + `start`/`end`, so the stream is replayable — this is what makes
 * the future audience-scrollback feature a pure add-on (history replay), not a
 * schema change.
 */
import { z } from "zod";

export * from "./export.js";
export * from "./correct.js";
export * from "./suggest.js";

/** Bumped on breaking changes to the message shapes below.
 *  v2: CaptionSegment gains `locked` (operator corrections) + populated `words`.
 *  v3: CaptionSegment gains `joinNext` (operator line-merge control).
 *  v4: CaptionSegment gains `keepRepeats` (opt out of auto repeat-collapse).
 *  v5: `setModel` client message (desktop live/refine model hot-swap).
 *  v6: `editSegment` client message (operator correction over the control WS).
 *  v7: `presence` server message (audience-room connected-device count).
 *  v8: QrOverlay gains `enabled`/`label`/`exclusive` (standalone operator-toggled
 *      overlay, any background mode); `roomControl` client message (desktop
 *      runtime room start/stop/restart). */
export const PROTOCOL_VERSION = 8;

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export const WordSchema = z.object({
  text: z.string(),
  /** seconds from session start */
  start: z.number(),
  /** seconds from session start */
  end: z.number(),
  /** decoder confidence 0..1, when available */
  confidence: z.number().min(0).max(1).optional(),
});
export type Word = z.infer<typeof WordSchema>;

/** How the FOLLOWING segment joins this one when rendered (operator line-merge).
 *  Absent = line break (default). "plain" = merge with no added punctuation (this
 *  segment already ends in . or ,). "comma"/"period" = merge inserting that mark. */
export const JoinNextSchema = z.enum(["plain", "comma", "period"]);
export type JoinNext = z.infer<typeof JoinNextSchema>;

export const CaptionSegmentSchema = z.object({
  /** stable id; a partial keeps the same id until it is finalized */
  id: z.string(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  /** speaker label (diarization, future) */
  speaker: z.string().optional(),
  /** BCP-47 language tag of `text` */
  lang: z.string().optional(),
  /** word-level timing (WhisperX alignment / export), when available */
  words: z.array(WordSchema).optional(),
  /** operator-corrected: the canonical text. Not overwritten by the engine
   *  (live re-emit) or the background refinement pass; a locked update wins. */
  locked: z.boolean().optional(),
  /** operator line-merge: how the next segment joins this one (see JoinNext) */
  joinNext: JoinNextSchema.optional(),
  /** opt out of automatic repeat-collapse (operator confirmed the repetition is
   *  real, e.g. "no no no") — render every instance instead of collapsing to one */
  keepRepeats: z.boolean().optional(),
});
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;

/**
 * Lock-aware upsert rule, shared by every upsert-by-id store (on-air
 * {@link CaptionStore}, operator UiStore, audience ViewerLog, room DO). An
 * operator-locked segment is the canonical text: a non-locked update (engine
 * partial→final re-emit, background refinement) must NOT overwrite it. A locked
 * update always wins (re-correction).
 */
export function canReplaceSegment(
  existing: CaptionSegment | undefined,
  incoming: CaptionSegment,
): boolean {
  return !(existing?.locked && !incoming.locked);
}

/** One rendered line: one or more segments merged via the operator line-merge. */
export interface JoinedLine {
  /** stable key = first member's id */
  key: string;
  /** source segments, in order (≥1) */
  members: CaptionSegment[];
  /** merged display text */
  text: string;
  start: number;
  end: number;
  /** any member operator-locked */
  locked: boolean;
}

/** True if `text` already ends in a hard period/comma so a merge mustn't add one. */
function endsHard(text: string): boolean {
  return /[.,]\s*$/.test(text);
}

/** Comparable core of a word (lowercase, punctuation stripped). */
export function normWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** Levenshtein edit distance (shared by dictionary correction + sound-alike ranking). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** A maximal run of a repeated phrase: tokens [start, start+period*reps) are
 *  `reps` consecutive copies of a `period`-word phrase. period 1 = a single word. */
export interface RepeatRun {
  start: number;
  period: number;
  reps: number;
}

/**
 * Find maximal consecutive phrase-repeat runs in a token list (normalized,
 * case/punctuation-insensitive). Catches both single-word loops ("warning warning
 * warning…", period 1) and phrase loops ("I'm sorry. I'm sorry.…", period 2+).
 * Smallest period wins; a word run needs `minWord`+ copies, a phrase `minPhrase`+
 * (so a natural double like "I'm sorry, I'm sorry" is spared).
 */
export function findRepeatRuns(
  tokens: string[],
  minWord = 3,
  minPhrase = 3,
  maxPeriod = 6,
): RepeatRun[] {
  const norm = tokens.map(normWord);
  const runs: RepeatRun[] = [];
  let i = 0;
  while (i < tokens.length) {
    let best: RepeatRun | null = null;
    for (let p = 1; p <= maxPeriod && i + 2 * p <= tokens.length; p++) {
      // The block must contain at least one real (non-empty normalized) word.
      let nonEmpty = false;
      for (let k = 0; k < p; k++) if (norm[i + k]) nonEmpty = true;
      if (!nonEmpty) continue;
      let reps = 1;
      for (;;) {
        const base = i + reps * p;
        if (base + p > tokens.length) break;
        let match = true;
        for (let k = 0; k < p; k++) {
          if (norm[base + k] !== norm[i + k]) {
            match = false;
            break;
          }
        }
        if (!match) break;
        reps++;
      }
      if (reps >= (p === 1 ? minWord : minPhrase)) {
        best = { start: i, period: p, reps };
        break; // smallest period wins
      }
    }
    if (best) {
      runs.push(best);
      i = best.start + best.period * best.reps;
    } else {
      i++;
    }
  }
  return runs;
}

/**
 * Collapse repetition loops down to a single occurrence — the antidote to Whisper
 * hallucinations on music/non-speech, both single words ("warning warning…") and
 * phrases ("I'm sorry. I'm sorry.…"). Applied by default on every render surface
 * so the audience never sees the loop; a segment can opt out with `keepRepeats`.
 */
export function collapseRepeats(text: string, minWord = 3, minPhrase = 3): string {
  const toks = text.split(/\s+/).filter(Boolean);
  const runs = findRepeatRuns(toks, minWord, minPhrase);
  const out: string[] = [];
  let i = 0;
  let r = 0;
  while (i < toks.length) {
    if (r < runs.length && runs[r]!.start === i) {
      const run = runs[r++]!;
      for (let k = 0; k < run.period; k++) out.push(toks[i + k]!); // keep one copy
      i += run.period * run.reps;
    } else {
      out.push(toks[i]!);
      i++;
    }
  }
  return out.join(" ");
}

/** Separator inserted before the next segment when merging onto `prevText`.
 *  Context-aware: if `prevText` already ends in . or , the added mark is dropped. */
export function joinSeparator(prevText: string, join: JoinNext): string {
  if (endsHard(prevText)) return " ";
  if (join === "comma") return ", ";
  if (join === "period") return ". ";
  return " ";
}

/**
 * Group finalized segments into rendered lines, honoring each segment's
 * `joinNext` (the operator line-merge control). Consecutive segments where the
 * earlier one has `joinNext` set are concatenated into one line with contextual
 * punctuation. Blank segments are skipped. Shared by every render surface
 * (operator preview, on-air display, audience viewer, export) so merges look the
 * same everywhere.
 */
export function joinSegments(segments: CaptionSegment[]): JoinedLine[] {
  // A segment's contributed text: repeat-runs collapsed to one by default, unless
  // the operator confirmed the repetition is real (keepRepeats).
  const memberText = (seg: CaptionSegment): string =>
    seg.keepRepeats ? seg.text.trim() : collapseRepeats(seg.text.trim());

  const lines: JoinedLine[] = [];
  for (const seg of segments) {
    const text = memberText(seg);
    if (!text) continue;
    const line = lines[lines.length - 1];
    const prev = line?.members[line.members.length - 1];
    if (line && prev?.joinNext) {
      line.text += joinSeparator(line.text, prev.joinNext) + text;
      line.members.push(seg);
      line.end = seg.end;
      line.locked = line.locked || !!seg.locked;
    } else {
      lines.push({
        key: seg.id,
        members: [seg],
        text,
        start: seg.start,
        end: seg.end,
        locked: !!seg.locked,
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Display configuration
// ---------------------------------------------------------------------------

export const BackgroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transparent") }),
  z.object({ kind: z.literal("solid"), color: z.string() }),
  /** chroma-key fill for switcher keying (default green) */
  z.object({ kind: z.literal("chroma"), color: z.string() }),
]);
export type Background = z.infer<typeof BackgroundSchema>;

export const DisplayPositionSchema = z.enum(["top", "center", "bottom"]);
export type DisplayPosition = z.infer<typeof DisplayPositionSchema>;

export const DisplayModeSchema = z.enum(["rolling", "scroll"]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

/**
 * Operator-defined caption box as a percentage of the output frame (0..100).
 * Lets the operator place/size captions to fit other on-screen content — e.g. a
 * lower-thirds band on a chroma-key canvas. When omitted, the display falls back
 * to {@link DisplayPositionSchema} placement across the full frame.
 */
export const CaptionRegionSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
});
export type CaptionRegion = z.infer<typeof CaptionRegionSchema>;

/**
 * QR overlay advertising the live audience room. A standalone, operator-toggled
 * element rendered by the display in ANY background mode (not chroma-only). It
 * breaks out of the caption box (big enough to scan across an auditorium).
 * Position is the top-left as % of frame; `size` is the square edge as % of the
 * smaller frame dimension.
 */
export const QrOverlaySchema = z.object({
  /** the room join/subscribe link the QR encodes */
  url: z.string(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  size: z.number().min(0).max(100),
  /** operator on/off toggle — false hides the overlay without dropping the url */
  enabled: z.boolean().default(true),
  /** caption shown beside the QR explaining it (e.g. "Scan for live captions") */
  label: z.string().default("Scan for live captions"),
  /** while shown, hide the caption lines (full-attention "scan now" moment) */
  exclusive: z.boolean().default(false),
});
export type QrOverlay = z.infer<typeof QrOverlaySchema>;

export const DisplayConfigSchema = z.object({
  fontFamily: z.string(),
  /** font size in viewport-height units (vh) so it scales with output res */
  fontSize: z.number().positive(),
  /** CSS font-weight (100–900) for the caption text */
  fontWeight: z.number().int().min(100).max(900),
  /** text flow direction; vertical uses CSS writing-mode (e.g. CJK / side displays) */
  orientation: z.enum(["horizontal", "vertical"]),
  color: z.string(),
  background: BackgroundSchema,
  position: DisplayPositionSchema,
  textAlign: z.enum(["left", "center", "right"]),
  /** rolling: keep last N lines; scroll: visible line budget */
  maxLines: z.number().int().positive(),
  mode: DisplayModeSchema,
  /** show the live (un-finalized) hypothesis in a dimmed style */
  showPartial: z.boolean(),
  uppercase: z.boolean(),
  /** opaque caption-box fill behind the text; omit/transparent = see-through */
  boxColor: z.string().optional(),
  /** caption-box corner radius in vh (rounded corners); 0/omit = square */
  boxRadius: z.number().min(0).optional(),
  /** operator-placed caption box (% of frame); omitted = full-frame + position */
  region: CaptionRegionSchema.optional(),
  /** live-room QR overlay; standalone operator-toggled, rendered in any mode */
  qr: QrOverlaySchema.optional(),
});
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>;

export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  fontFamily:
    "'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif",
  fontSize: 6,
  fontWeight: 700,
  orientation: "horizontal",
  color: "#ffffff",
  // Default solid black suits HDMI capture; switch to chroma/transparent per workflow.
  background: { kind: "solid", color: "#000000" },
  position: "bottom",
  textAlign: "center",
  maxLines: 2,
  mode: "rolling",
  showPartial: true,
  uppercase: false,
};

// ---------------------------------------------------------------------------
// Engine status
// ---------------------------------------------------------------------------

export const EngineStateSchema = z.enum([
  "idle",
  "loading", // model loading / warming up
  "listening",
  "error",
]);
export type EngineState = z.infer<typeof EngineStateSchema>;

export const EngineStatusSchema = z.object({
  state: EngineStateSchema,
  /** engine/backend identifier, e.g. "faster-whisper", "transformers.js" */
  backend: z.string().optional(),
  model: z.string().optional(),
  /** WebGPU / CUDA / Metal / CPU */
  device: z.string().optional(),
  message: z.string().optional(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

export const PartialMessageSchema = z.object({
  type: z.literal("partial"),
  segment: CaptionSegmentSchema,
});
export const FinalMessageSchema = z.object({
  type: z.literal("final"),
  segment: CaptionSegmentSchema,
});
export const ClearMessageSchema = z.object({ type: z.literal("clear") });
export const ConfigMessageSchema = z.object({
  type: z.literal("config"),
  config: DisplayConfigSchema,
});
export const StatusMessageSchema = z.object({
  type: z.literal("status"),
  status: EngineStatusSchema,
});
/** Replay of finalized segments — for late joiners and audience scrollback. */
export const HistoryMessageSchema = z.object({
  type: z.literal("history"),
  segments: z.array(CaptionSegmentSchema),
});
/** Audience-room presence: how many subscriber devices are currently connected.
 *  Emitted by the CaptionRoom DO on every connect/disconnect. */
export const PresenceMessageSchema = z.object({
  type: z.literal("presence"),
  count: z.number().int().nonnegative(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  PartialMessageSchema,
  FinalMessageSchema,
  ClearMessageSchema,
  ConfigMessageSchema,
  StatusMessageSchema,
  HistoryMessageSchema,
  PresenceMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Client -> server (control) messages
// ---------------------------------------------------------------------------

export const SetConfigMessageSchema = z.object({
  type: z.literal("setConfig"),
  config: DisplayConfigSchema.partial(),
});
export const SetDictionaryMessageSchema = z.object({
  type: z.literal("setDictionary"),
  /** event-specific names/jargon to bias decoding toward */
  terms: z.array(z.string()),
});
export const ControlCommandSchema = z.object({
  type: z.literal("command"),
  command: z.enum(["start", "stop", "clear"]),
});
/** Request replayable history (since N seconds from session start). */
export const RequestHistoryMessageSchema = z.object({
  type: z.literal("requestHistory"),
  since: z.number().optional(),
});
/** Hot-swap the desktop ASR model without restarting (live + optional refine). */
export const SetModelMessageSchema = z.object({
  type: z.literal("setModel"),
  /** live model name or HF repo (e.g. "small.en", "large-v3-turbo") */
  model: z.string(),
  /** refinement-pass model; omit to leave it unchanged */
  refineModel: z.string().optional(),
});
/** Operator correction from a control client: the corrected (locked) segment,
 *  applied to the canonical log by id (lock-aware upsert) and rebroadcast. */
export const EditSegmentMessageSchema = z.object({
  type: z.literal("editSegment"),
  segment: CaptionSegmentSchema,
});
/** Desktop runtime audience-room control from a control client (operator panel):
 *  `start` mints + publishes a fresh room, `stop` tears it down, `restart`
 *  reopens the last stopped room. Optional `qr` overrides seed the join overlay
 *  (position/size/label/exclusive) chosen in the panel. */
export const RoomControlMessageSchema = z.object({
  type: z.literal("roomControl"),
  action: z.enum(["start", "stop", "restart"]),
  /** overlay overrides for the minted join QR (url is filled in server-side) */
  qr: QrOverlaySchema.omit({ url: true }).partial().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  SetConfigMessageSchema,
  SetDictionaryMessageSchema,
  ControlCommandSchema,
  RequestHistoryMessageSchema,
  SetModelMessageSchema,
  EditSegmentMessageSchema,
  RoomControlMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + validate an inbound server message (throws on invalid). */
export function parseServerMessage(data: unknown): ServerMessage {
  return ServerMessageSchema.parse(typeof data === "string" ? JSON.parse(data) : data);
}

/** Parse + validate an inbound client/control message (throws on invalid). */
export function parseClientMessage(data: unknown): ClientMessage {
  return ClientMessageSchema.parse(typeof data === "string" ? JSON.parse(data) : data);
}

/** Safe variant: returns null instead of throwing. */
export function safeParseServerMessage(data: unknown): ServerMessage | null {
  const json = typeof data === "string" ? safeJson(data) : data;
  const r = ServerMessageSchema.safeParse(json);
  return r.success ? r.data : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
