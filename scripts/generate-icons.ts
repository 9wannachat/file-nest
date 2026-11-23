/**
 * Render PWA icons from public/icons/*.svg with headless Chromium.
 *   node scripts/generate-icons.ts
 * Replace favicon.svg / maskable.svg with the project logo and re-run.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const jobs: [src: string, out: string, size: number, bg?: string][] = [
  ["public/icons/favicon.svg", "public/icons/icon-192.png", 192],
  ["public/icons/favicon.svg", "public/icons/icon-512.png", 512],
  ["public/icons/maskable.svg", "public/icons/icon-maskable-512.png", 512],
  ["public/icons/maskable.svg", "public/icons/apple-touch-icon.png", 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of jobs) {
  const svg = readFileSync(src, "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  writeFileSync(out, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log("wrote", out);
}
await browser.close();
