import catalog from "../../shared/video-effect-templates.json";

export const VIDEO_EFFECT_TEMPLATES = catalog.items.map(item => ({
  uuid: item.uuid, versionId: item.versionId, versionUuid: item.versionUuid,
  name: item.name, image: `/video-effects/${item.versionId}.webp`,
  sourceUrl: item.sourceUrl,
  prompt: [item.versionIntro.promptConfig.prefix, item.versionIntro.promptConfig.systemPrompt, item.versionIntro.effectPrompt, item.versionIntro.promptConfig.suffix].filter(Boolean).join("\n"),
}));
export type VideoEffectTemplate = (typeof VIDEO_EFFECT_TEMPLATES)[number];
export const MAX_VIDEO_EFFECTS = 6;
const FAVORITES_KEY = "canvas:video-effects:favorites:v1";
const RECENT_KEY = "canvas:video-effects:recent:v1";
function readEffectIds(key: string): readonly number[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number" && VIDEO_EFFECT_TEMPLATES.some(item => item.versionId === id)) : []; }
  catch { return []; }
}
export function readVideoEffectFavorites(): readonly number[] { return readEffectIds(FAVORITES_KEY); }
export function saveVideoEffectFavorites(ids: readonly number[]): void { localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids)); }
export function readRecentVideoEffects(): readonly number[] { return readEffectIds(RECENT_KEY); }
export function rememberVideoEffect(id: number): void {
  const next = [id, ...readRecentVideoEffects().filter((value) => value !== id)].slice(0, 100);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); }
  catch { /* 本机历史写入失败不应影响已经应用的模板。 */ }
}
