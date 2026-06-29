import { Viewer } from "@captions/display";
import { mount } from "svelte";

// Audience viewer page (the QR/join target). Picks its room from the URL, e.g.
// viewer.html?source=room&room=<id>[&base=<room ws origin>].
const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

export default mount(Viewer, { target });
