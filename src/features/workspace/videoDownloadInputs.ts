/** 提取一段文本（分享口令或纯链接）里的全部 URL，去掉结尾的中文标点。 */
export function extractVideoUrls(text: string): readonly string[] {
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"'`]+/gi), (match) =>
    match[0].replace(/[，。；、！？）\]】}]+$/u, ""),
  );
}

/** Extract each URL independently so a batch never silently downloads only the first link. */
export function videoDownloadInputs(
  manual: string,
  connectedTexts: readonly string[],
): readonly string[] {
  const results = new Map<string, string>();
  const manualUrls = extractVideoUrls(manual);
  if (manual.trim()) {
    if (manualUrls.length <= 1) results.set(manualUrls[0] ?? manual.trim(), manual.trim());
    else for (const url of manualUrls) results.set(url, url);
  }
  for (const text of connectedTexts) {
    for (const url of extractVideoUrls(text)) if (!results.has(url)) results.set(url, url);
  }
  return [...results.values()];
}
