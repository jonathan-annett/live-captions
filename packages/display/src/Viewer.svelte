<script lang="ts">
  import { onMount, tick } from "svelte";
  import { ViewerStore } from "./viewerStore.svelte.js";
  import {
    createSourceFromUrl,
    type CaptionSource,
    type ConnectionState,
  } from "./sources/index.js";
  import { connectionView, isNearBottom } from "./viewerView.js";

  // Audience-facing mobile viewer: an uncapped, scroll-back transcript bound to
  // a ViewerStore, fed by whatever source the URL selects (a RoomSource in
  // production; the mock script in dev).
  const store = new ViewerStore();
  let connection = $state<ConnectionState>("connecting");
  let following = $state(true);
  let source: CaptionSource | undefined;
  let scroller = $state<HTMLElement | undefined>(undefined);

  const conn = $derived(connectionView(connection));

  onMount(() => {
    source = createSourceFromUrl();
    source.connect(store.apply, (s) => (connection = s));
    return () => source?.disconnect();
  });

  // Follow the live tail while the user is at the bottom; new finals/partials
  // re-trigger this effect by being read.
  $effect(() => {
    void store.segments.length;
    void store.partial;
    if (following && scroller) {
      void tick().then(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    }
  });

  function onScroll() {
    if (!scroller) return;
    following = isNearBottom(
      scroller.scrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
  }

  function jumpToLive() {
    following = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }
</script>

<div
  class="viewer"
  style:--cap-font={store.config.fontFamily}
  style:--cap-color={store.config.color}
  style:--cap-transform={store.config.uppercase ? "uppercase" : "none"}
  style:--cap-align={store.config.textAlign}
>
  <header class="bar">
    <span class="status" class:live={conn.live} aria-live="polite">
      <span class="dot"></span>{conn.label}
    </span>
  </header>

  <main class="scroll" bind:this={scroller} onscroll={onScroll}>
    {#if store.segments.length === 0 && !store.partial}
      <p class="empty">Waiting for captions…</p>
    {/if}
    {#each store.segments as segment (segment.id)}
      <p class="line">{segment.text}</p>
    {/each}
    {#if store.partial && store.config.showPartial}
      <p class="line partial">{store.partial.text}</p>
    {/if}
  </main>

  {#if !following}
    <button class="jump" onclick={jumpToLive}>↓ Jump to live</button>
  {/if}
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #0b0b0d;
    color: var(--cap-color, #fff);
    font-family: var(--cap-font, system-ui, sans-serif);
  }
  .bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem 1rem;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    color: #aaa;
    letter-spacing: 0.02em;
  }
  .status.live {
    color: #5fe39b;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0.5rem currentColor;
  }
  .scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 1rem 1.1rem 2rem;
    scroll-behavior: smooth;
  }
  .empty {
    color: #666;
    text-align: center;
    margin-top: 30vh;
  }
  .line {
    margin: 0 0 0.7rem;
    font-size: 1.4rem;
    line-height: 1.4;
    text-align: var(--cap-align, left);
    text-transform: var(--cap-transform, none);
    word-wrap: break-word;
  }
  .line.partial {
    opacity: 0.55;
  }
  .jump {
    position: absolute;
    left: 50%;
    bottom: 1.2rem;
    transform: translateX(-50%);
    padding: 0.55rem 1.1rem;
    border: none;
    border-radius: 999px;
    background: #5fe39b;
    color: #08210f;
    font-size: 0.9rem;
    font-weight: 600;
    box-shadow: 0 0.3rem 1rem rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
</style>
