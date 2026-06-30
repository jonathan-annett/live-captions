<script lang="ts">
  import { onMount } from "svelte";
  import type { Background } from "@captions/protocol";
  import { CaptionStore } from "./captionStore.svelte.js";
  import { qrSvg } from "./qr.js";
  import { createSourceFromUrl, type CaptionSource } from "./sources/index.js";

  const store = new CaptionStore();
  let source: CaptionSource;

  onMount(() => {
    source = createSourceFromUrl();
    source.connect(store.apply);
    return () => source.disconnect();
  });

  function backgroundCss(bg: Background): string {
    switch (bg.kind) {
      case "transparent":
        return "transparent";
      case "solid":
      case "chroma":
        return bg.color;
    }
  }

  const justify = $derived(
    store.config.position === "top"
      ? "flex-start"
      : store.config.position === "center"
        ? "center"
        : "flex-end",
  );

  // Operator-placed caption box (% of frame). When set, the captions occupy
  // this box (e.g. lower-thirds on a chroma canvas); otherwise they span the
  // full frame and `position` governs vertical placement.
  const region = $derived(store.config.region);

  // Optional opaque caption-box fill + rounded corners (3 colours: chroma key,
  // box fill, text). When boxColor is unset the box is see-through.
  const boxColor = $derived(store.config.boxColor);
  const boxRadius = $derived(store.config.boxRadius ?? 0);

  // Live-room QR overlay — only meaningful when the output is keyed, so it's
  // gated to chroma mode (it breaks out of the caption box onto the green).
  const qr = $derived(store.config.qr);
  const isChroma = $derived(store.config.background.kind === "chroma");
</script>

<div
  class="stage"
  style:background={backgroundCss(store.config.background)}
  style:justify-content={justify}
  style:--cap-color={store.config.color}
  style:--cap-font={store.config.fontFamily}
  style:--cap-size="{store.config.fontSize}vh"
  style:--cap-align={store.config.textAlign}
  style:--cap-transform={store.config.uppercase ? "uppercase" : "none"}
>
  <div
    class="captions"
    class:boxed={region}
    class:filled={boxColor}
    style:background={boxColor ?? null}
    style:border-radius={boxRadius ? `${boxRadius}vh` : null}
    style:left={region ? `${region.x}%` : null}
    style:top={region ? `${region.y}%` : null}
    style:width={region ? `${region.width}%` : null}
    style:height={region ? `${region.height}%` : null}
    style:justify-content={region ? justify : null}
  >
    {#each store.lines as line (line.text + line.partial)}
      <div class="line" class:partial={line.partial}>{line.text}</div>
    {/each}
  </div>

  {#if qr && isChroma}
    <div
      class="qr"
      style:left={`${qr.x}%`}
      style:top={`${qr.y}%`}
      style:width={`${qr.size}vmin`}
      style:height={`${qr.size}vmin`}
    >
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- generated, no user HTML -->
      {@html qrSvg(qr.url)}
    </div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 4vh 6vw;
  }
  .captions {
    width: 100%;
    text-align: var(--cap-align);
  }
  /* Opaque caption box: pad the text off the fill edges (em scales with size). */
  .captions.filled {
    padding: 0.3em 0.6em;
    box-sizing: border-box;
  }
  /* Operator-placed box: absolute within the frame, content laid out vertically. */
  .captions.boxed {
    position: absolute;
    box-sizing: border-box;
    width: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .line {
    color: var(--cap-color);
    font-family: var(--cap-font);
    font-size: var(--cap-size);
    line-height: 1.25;
    font-weight: 700;
    text-transform: var(--cap-transform);
    /* Outline for legibility over busy backgrounds (transparent/keyed). */
    text-shadow:
      0 0 0.5vh rgba(0, 0, 0, 0.9),
      0 0.2vh 0.4vh rgba(0, 0, 0, 0.7);
    transition: opacity 0.15s ease;
  }
  .line.partial {
    opacity: 0.6;
  }
  /* Live-room QR: a square on the keyed canvas, can sit outside the caption box. */
  .qr {
    position: absolute;
  }
  .qr :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
