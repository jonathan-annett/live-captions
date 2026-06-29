import { App } from "@captions/display";
import { mount } from "svelte";

// The on-air surface for PWA mode — the *same* component the desktop build and
// the display package use. It picks its transport from the URL; this page is
// opened as display.html?source=broadcast&channel=captions.
const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

export default mount(App, { target });
