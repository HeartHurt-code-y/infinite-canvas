/** Extract each URL independently so a batch never silently downloads only the first link. */
export function videoDownloadInputs(
  manual: string,
  connectedTexts: readonly string[],
): readonly string[] {
  const results = new Map<string, string>();
  const urlsIn = (text: string) =>
    Array.from(text.matchAll(/https?:\/\/[^\s<>"'`]+/gi), (match) =>
      match[0].replace(/[，。；、！？）\]】}]+$/u, ""),
    );
  const manualUrls = urlsIn(manual);
  if (manual.trim()) {
    if (manualUrls.length <= 1) results.set(manualUrls[0] ?? manual.trim(), manual.trim());
    else for (const url of manualUrls) results.set(url, url);
  }
  for (const text of connectedTexts) {
    for (const url of urlsIn(text)) if (!results.has(url)) results.set(url, url);
  }
  return [...results.values()];
}
