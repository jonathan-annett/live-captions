import { mount } from "svelte";
import Viewer from "./Viewer.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

export default mount(Viewer, { target });
