<script lang="ts">
  import { joinSegments, type CaptionSegment } from "@captions/protocol";
  import {
    applyEdit,
    applyJoin,
    applyKeepRepeats,
    applyRangeEdit,
    groupTokens,
    nextJoin,
    segmentTokens,
  } from "./engine/correct.js";
  import { suggestCorrections } from "./engine/suggest.js";

  interface Props {
    /** finalized segments to offer for correction (newest last) */
    segments: CaptionSegment[];
    /** custom-dictionary terms used to rank sound-alike suggestions */
    dictionary: string[];
    /** emit a corrected (locked) segment to display + room + preview */
    onApply: (seg: CaptionSegment) => void;
    /** restore the segment's pre-correction state */
    onUndo: () => void;
    canUndo: boolean;
  }

  const { segments, dictionary, onApply, onUndo, canUndo }: Props = $props();

  // Words below this (heuristic/decoder) confidence are highlighted as suspect.
  const LOW_CONF = 0.6;
  // How many recent segments to render at once (bounded DOM); "Show earlier"
  // grows the window so the operator can reach back through the whole session.
  const PAGE = 200;

  let sel = $state<{ id: string; index: number } | null>(null);
  let runSel = $state<{
    id: string;
    start: number;
    period: number;
    count: number;
    text: string;
  } | null>(null);
  let replacement = $state("");
  let shown = $state(PAGE);
  const visible = $derived(segments.slice(-shown));
  const hidden = $derived(Math.max(0, segments.length - shown));
  // Rendered lines (operator merges applied); the boundary control after each
  // segment except the very last lets the operator merge/split that boundary.
  const lines = $derived(joinSegments(visible));
  const lastId = $derived(visible[visible.length - 1]?.id);

  function toggleJoin(seg: CaptionSegment) {
    onApply(applyJoin(seg, nextJoin(seg)));
  }

  // Auto-scroll: keep the newest in view, but don't yank the operator back to
  // the bottom while they've scrolled up to correct older text.
  let linesEl = $state<HTMLDivElement | undefined>(undefined);
  let stick = $state(true);
  function onScroll() {
    if (!linesEl) return;
    stick = linesEl.scrollTop + linesEl.clientHeight >= linesEl.scrollHeight - 24;
  }
  $effect(() => {
    void segments.length; // re-run as finals arrive
    if (stick && linesEl) linesEl.scrollTop = linesEl.scrollHeight;
  });

  const selSeg = $derived(
    sel ? (segments.find((s) => s.id === sel!.id) ?? null) : null,
  );
  const selWord = $derived(
    selSeg ? (segmentTokens(selSeg)[sel!.index]?.text ?? "") : "",
  );
  const suggestions = $derived(
    selWord ? suggestCorrections(selWord, dictionary) : [],
  );

  function pick(id: string, index: number, text: string) {
    runSel = null;
    sel = { id, index };
    replacement = text;
  }

  function commit(text: string) {
    if (!selSeg || !sel) return;
    onApply(applyEdit(selSeg, sel.index, text));
    sel = null;
  }

  function pickRun(
    id: string,
    start: number,
    period: number,
    count: number,
    text: string,
  ) {
    sel = null;
    runSel = { id, start, period, count, text };
  }

  function deleteRun() {
    if (!runSel) return;
    const seg = segments.find((s) => s.id === runSel!.id);
    // The run spans period × count tokens; delete the whole thing.
    if (seg) onApply(applyRangeEdit(seg, runSel.start, runSel.period * runSel.count, 0));
    runSel = null;
  }

  function keepAll() {
    if (!runSel) return;
    const seg = segments.find((s) => s.id === runSel!.id);
    if (seg) onApply(applyKeepRepeats(seg));
    runSel = null;
  }
</script>

<section class="corrections">
  <div class="head">
    <span>Corrections</span>
    <button class="undo" onclick={onUndo} disabled={!canUndo}>Undo</button>
  </div>

  {#if !segments.length}
    <p class="empty">Finalized captions appear here — click a word to correct it.</p>
  {/if}

  <div class="lines" bind:this={linesEl} onscroll={onScroll}>
    {#if hidden > 0}
      <button class="earlier" onclick={() => (shown += PAGE)}>
        ▲ Show {Math.min(PAGE, hidden)} earlier ({hidden} hidden)
      </button>
    {/if}
    {#each lines as line (line.key)}
      <div class="line" class:locked={line.locked}>
        {#each line.members as seg (seg.id)}
          {#each groupTokens(seg) as g (g.kind === "run" ? `r${g.start}` : `w${g.index}`)}
            {#if g.kind === "word"}
              <button
                class="word"
                class:lowconf={g.confidence !== undefined && g.confidence < LOW_CONF}
                class:active={sel?.id === seg.id && sel?.index === g.index}
                onclick={() => pick(seg.id, g.index, g.text)}
              >{g.text}</button>
            {:else}
              <!-- Auto-collapsed to one instance (highlighted); shows the
                   suppressed count. Click to delete entirely or keep all. -->
              <button
                class="run"
                class:active={runSel?.id === seg.id && runSel?.start === g.start}
                title={`Repeated ${g.count}× — auto-collapsed to one. Click to delete or keep all.`}
                onclick={() => pickRun(seg.id, g.start, g.period, g.count, g.text)}
              >{g.text}<span class="badge">×{g.count}</span></button>
            {/if}
          {/each}
          {#if seg.id !== lastId}
            <button
              class="join"
              class:merged={!!seg.joinNext}
              title={seg.joinNext
                ? "Merged with the next line — click to change"
                : "Click to merge the next line"}
              aria-label="Toggle line merge"
              onclick={() => toggleJoin(seg)}
            ><span class="ret">⏎</span>{#if seg.joinNext === "comma"}<span
                  class="pc comma">,</span
                >{:else if seg.joinNext === "period"}<span class="pc period">.</span
                >{/if}</button>
          {/if}
        {/each}
      </div>
    {/each}
  </div>

  {#if selSeg && sel}
    <div class="editor">
      <div class="editing">
        Editing <strong>{selWord}</strong>
        <button class="close" onclick={() => (sel = null)} aria-label="Cancel">✕</button>
      </div>
      {#if suggestions.length}
        <div class="suggest">
          {#each suggestions as s (s)}
            <button class="chip" onclick={() => commit(s)}>{s}</button>
          {/each}
        </div>
      {/if}
      <div class="manual">
        <input
          type="text"
          bind:value={replacement}
          placeholder="Replacement…"
          onkeydown={(e) => e.key === "Enter" && commit(replacement)}
        />
        <button onclick={() => commit(replacement)}>Apply</button>
        <button class="suppress" onclick={() => commit("")}>Suppress</button>
      </div>
    </div>
  {/if}

  {#if runSel}
    <div class="editor">
      <div class="editing">
        <strong>{runSel.text}</strong> repeated {runSel.count}× — collapsed to one
        <button class="close" onclick={() => (runSel = null)} aria-label="Cancel">✕</button>
      </div>
      <div class="manual">
        <button class="suppress" onclick={deleteRun}>Delete entirely</button>
        <button onclick={keepAll}>Keep all {runSel.count}</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .corrections {
    margin-top: 1rem;
    border-top: 1px solid #2a2a2a;
    padding-top: 0.75rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
    color: #bbb;
    margin-bottom: 0.5rem;
  }
  .undo {
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
  }
  .empty {
    color: #777;
    font-size: 0.85rem;
    margin: 0.25rem 0;
  }
  .lines {
    max-height: 20rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .earlier {
    align-self: center;
    font-size: 0.75rem;
    padding: 0.2rem 0.7rem;
    margin-bottom: 0.2rem;
    color: #9ab;
    background: #1a1a1a;
  }
  .line {
    line-height: 1.5;
  }
  .line.locked {
    border-left: 2px solid #5fe39b;
    padding-left: 0.4rem;
  }
  .word {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    padding: 0 0.12rem;
    margin: 0;
    border-radius: 3px;
    cursor: pointer;
  }
  .word:hover {
    background: #333;
  }
  .word.lowconf {
    background: #3a2f10;
    color: #e3c45f;
  }
  .word.active {
    background: #1f4d8f;
    color: #fff;
  }
  /* Auto-collapsed repetition: the single kept instance, highlighted, with the
     suppressed count as a small badge. Click to delete entirely or keep all. */
  .run {
    background: #3a1414;
    color: #e38f8f;
    border: 1px solid #5c1d1d;
    border-radius: 3px;
    padding: 0 0.2rem;
    margin: 0 0.05rem;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .run:hover,
  .run.active {
    background: #5c1d1d;
    color: #ffd9d9;
  }
  .run .badge {
    font-size: 0.7em;
    opacity: 0.8;
    margin-left: 0.15rem;
    vertical-align: super;
  }
  /* Line-merge boundary control (editor-only; never shown on air/audience). */
  .join {
    background: none;
    border: none;
    padding: 0 0.2rem;
    margin: 0 0.05rem;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    /* finger-sized so the same control works as a tap target on mobile */
    min-width: 1.6rem;
    min-height: 1.6rem;
  }
  .join:hover {
    background: #333;
  }
  /* ⏎ bright = line break (default); dimmed once the next line is merged in. */
  .join .ret {
    color: #c8ccd2;
  }
  .join.merged .ret {
    color: #555;
  }
  .join .pc {
    font-weight: 700;
    margin-left: 0.05rem;
  }
  .join .pc.comma {
    color: #e3c45f;
  }
  .join .pc.period {
    color: #e36f6f;
  }
  .editor {
    margin-top: 0.6rem;
    background: #181818;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: 0.6rem;
  }
  .editing {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #ccc;
    margin-bottom: 0.45rem;
  }
  .editing strong {
    color: #fff;
  }
  .close {
    margin-left: auto;
    padding: 0.1rem 0.4rem;
  }
  .suggest {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.45rem;
  }
  .chip {
    padding: 0.25rem 0.65rem;
    border-radius: 999px;
    background: #10391f;
    color: #5fe39b;
    border: 1px solid #1d5c34;
  }
  .manual {
    display: flex;
    gap: 0.4rem;
  }
  .manual input {
    flex: 1;
    min-width: 0;
  }
  .suppress {
    background: #3a1414;
    color: #e38f8f;
  }
</style>
