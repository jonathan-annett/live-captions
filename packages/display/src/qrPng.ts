import { qrSvg } from "./qr.js";

export interface QrSlideOptions {
  width?: number;
  height?: number;
  background?: string;
  foreground?: string;
  title?: string;
}

/**
 * Render a full-frame "scan to join" slide as a PNG Blob — a large centered QR
 * plus the join URL — for dropping into PowerPoint or loading into other gear,
 * in lieu of the live chroma overlay. Browser-only (uses <canvas>); not imported
 * by the node test suite.
 */
export async function qrSlidePngBlob(
  url: string,
  opts: QrSlideOptions = {},
): Promise<Blob> {
  const {
    width = 1920,
    height = 1080,
    background = "#000000",
    foreground = "#ffffff",
    title = "Scan to follow live captions",
  } = opts;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // QR (its own white quiet zone) sized to ~55% of the shorter edge, centered.
  const qrPx = Math.round(Math.min(width, height) * 0.55);
  const qrImg = await svgToImage(qrSvg(url));
  const qx = (width - qrPx) / 2;
  const qy = (height - qrPx) / 2 - height * 0.03;
  ctx.drawImage(qrImg, qx, qy, qrPx, qrPx);

  ctx.fillStyle = foreground;
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.round(height * 0.05)}px system-ui, sans-serif`;
  ctx.fillText(title, width / 2, qy - height * 0.05);
  ctx.font = `400 ${Math.round(height * 0.028)}px system-ui, sans-serif`;
  ctx.fillText(url, width / 2, qy + qrPx + height * 0.08);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(objectUrl);
      reject(e);
    };
    img.src = objectUrl;
  });
}
