<script lang="ts">
  import type { CaptionSegment } from "@captions/protocol";
  import { applyEdit, segmentTokens } from "./engine/correct.js";
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

  let sel = $state<{ id: string; index: number } | null>(null);
  let replacement = $state("");

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
    sel = { id, index };
    replacement = text;
  }

  function commit(text: string) {
    if (!selSeg || !sel) return;
    onApply(applyEdit(selSeg, sel.index, text));
    sel = null;
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

  <div class="lines">
    {#each segments as seg (seg.id)}
      <div class="line" class:locked={seg.locked}>
        {#each segmentTokens(seg) as tok, i (i)}
          <button
            class="word"
            class:lowconf={tok.confidence !== undefined && tok.confidence < LOW_CONF}
            class:active={sel?.id === seg.id && sel?.index === i}
            onclick={() => pick(seg.id, i, tok.text)}
          >{tok.text}</button>
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
    max-height: 11rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
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
