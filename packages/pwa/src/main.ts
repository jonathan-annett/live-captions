import { PROTOCOL_VERSION } from "@captions/protocol";
import "./style.css";

// Placeholder landing page. The in-browser Whisper engine, audio capture, and
// the embedded display route land in M3. This exists now so the Cloudflare
// Pages build/deploy pipeline is wired up and auto-deploys on every push.

const webgpu = "gpu" in navigator;
const isolated = self.crossOriginIsolated;

const app = document.getElementById("app")!;
app.innerHTML = `
  <main>
    <h1>Live Captions</h1>
    <p>On-device live captioning. Audio never leaves your device.</p>
    <p class="muted">PWA shell deployed · protocol v${PROTOCOL_VERSION}</p>
    <ul class="caps">
      <li>${webgpu ? "✅" : "⚠️"} WebGPU ${webgpu ? "available" : "unavailable (will fall back to WASM)"}</li>
      <li>${isolated ? "✅" : "⚠️"} Cross-origin isolated ${isolated ? "(threaded WASM enabled)" : "(headers not active)"}</li>
    </ul>
    <p class="muted">Engine coming in M3.</p>
  </main>
`;
