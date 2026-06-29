import qrcode from "qrcode-generator";

/**
 * QR helpers for the live-room overlay (and the operator's downloadable PNG).
 *
 * Pure functions over the module matrix so they're unit-testable and render to
 * crisp, resolution-independent SVG — ideal for projection at any output size.
 */

/** QR module matrix (`true` = dark module) for `text`. */
export function qrMatrix(text: string, ec: "L" | "M" | "Q" | "H" = "M"): boolean[][] {
  const qr = qrcode(0, ec); // typeNumber 0 = auto-size to the data
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

export interface QrSvgOptions {
  /** quiet-zone border in modules (spec minimum is 4) */
  margin?: number;
  dark?: string;
  light?: string;
}

/** Render `text` as a standalone, scalable QR SVG string. */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { margin = 4, dark = "#000000", light = "#ffffff" } = opts;
  const m = qrMatrix(text);
  const n = m.length;
  const dim = n + margin * 2;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r]![c]) rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects}</g></svg>`
  );
}
