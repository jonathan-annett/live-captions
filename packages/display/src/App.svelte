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

  // In a fixed box we render a deeper window (bottom-anchored, clipped) so older
  // text scrolls off the top; full-frame keeps the bounded rolling lines.
  const visibleLines = $derived(region ? store.recentLines : store.lines);

  // Standalone operator-toggled QR overlay — renders in ANY background mode
  // (solid/transparent/chroma) whenever the operator enables it.
  const qr = $derived(store.config.qr);
  const qrActive = $derived(!!qr?.enabled);
  // Exclusive mode: a full-attention "scan now" moment — hide caption lines so
  // only the QR + label show.
  const qrExclusive = $derived(qrActive && !!qr?.exclusive);
</script>

<div
  class="stage"
  style:background={backgroundCss(store.config.background)}
  style:justify-content={justify}
  style:--cap-color={store.config.color}
  style:--cap-font={store.config.fontFamily}
  style:--cap-size="{store.config.fontSize}vh"
  style:--cap-weight={store.config.fontWeight}
  style:--cap-orient={store.config.orientation === "vertical" ? "vertical-rl" : "horizontal-tb"}
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
    style:justify-content={region ? "flex-end" : null}
  >
    {#if !qrExclusive}
      {#each visibleLines as line (line.key)}
        <div class="line" class:partial={line.partial}>{line.text}</div>
      {/each}
    {/if}
  </div>

  {#if qrActive && qr}
    <div
      class="qr"
      style:left={`${qr.x}%`}
      style:top={`${qr.y}%`}
      style:width={`${qr.size}vmin`}
    >
      <div class="qr-code" style:height={`${qr.size}vmin`}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- generated, no user HTML -->
        {@html qrSvg(qr.url)}
      </div>
      {#if qr.label}
        <div class="qr-label">{qr.label}</div>
      {/if}
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
    writing-mode: var(--cap-orient, horizontal-tb);
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
    font-weight: var(--cap-weight, 700);
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
  /* Standalone QR overlay: the QR code (square) plus an optional caption label,
     positioned/sized by the operator. Renders over any background mode. */
  .qr {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .qr-code {
    width: 100%;
  }
  .qr-code :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .qr-label {
    margin-top: 0.6em;
    color: #fff;
    font-family: var(--cap-font);
    font-weight: 700;
    /* Proportional to the QR square so it stays readable at a distance. */
    font-size: 2.4vmin;
    line-height: 1.2;
    text-align: center;
    text-shadow:
      0 0 0.5vh rgba(0, 0, 0, 0.9),
      0 0.2vh 0.4vh rgba(0, 0, 0, 0.8);
  }
</style>
