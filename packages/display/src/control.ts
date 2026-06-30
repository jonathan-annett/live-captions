import { mount } from "svelte";
import ControlPanel from "./ControlPanel.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

export default mount(ControlPanel, { target });
