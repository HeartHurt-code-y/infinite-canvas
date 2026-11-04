/** 图片空态图标，依据 2026-11-03 LibTV 活体 DOM 的可见 SVG。 */
export function CanvasImageIcon({ name, size = 16 }: { readonly name: "empty" | "upload"; readonly size?: number }) {
  if (name === "empty") return <svg width={size} height={size} viewBox="0 0 66 66" aria-hidden="true" focusable="false" fill="currentColor"><path d="M26.46 19.21a1.32 1.32 0 0 1 2.2 0l12.17 18.25 3.7-5.45a1.32 1.32 0 0 1 2.19 0l8.73 12.83c.6.87-.04 2.06-1.1 2.06H10.47a1.32 1.32 0 0 1-1.1-2.05z"/><circle cx="42.24" cy="20.46" r="3.96"/></svg>;
  return <svg width={size} height={size} viewBox="0 0 19.8 19.8" aria-hidden="true" focusable="false" fill="currentColor"><path d="M1.8 16.9A1.1 1.1 0 0 0 2.9 18h14a1.1 1.1 0 0 0 1.1-1.1V12h1.8v4.9a2.9 2.9 0 0 1-2.9 2.9h-14A2.9 2.9 0 0 1 0 16.9V12h1.8zM9.33.2a.9.9 0 0 1 1.2.06l5.64 5.64-1.27 1.27-4.1-4.1V13.8H9V3.07l-4.1 4.1L3.63 5.9 9.26.26z"/></svg>;
}
