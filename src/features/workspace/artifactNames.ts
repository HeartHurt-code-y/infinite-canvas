/** Names are labels; task/result identities and the saved source path remain stable. */
export function validateArtifactName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 80 || new TextEncoder().encode(name).length > 180) {
    return "请输入名称，最多 80 个字符（中文最多 60 个）。";
  }
  if (
    /[\\/:*?"<>|]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    /[. ]$/.test(name)
  ) {
    return '名称不能包含 \\ / : * ? " < > |，也不能以句点结尾。';
  }
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
    return "这个名称被系统保留，请换一个名称。";
  }
  return null;
}

export function artifactFileName(name: string, sourcePath: string): string {
  const source = sourcePath.split(/[\\/]/).pop() ?? "";
  const extension = /\.[^.]+$/.exec(source)?.[0] ?? "";
  const trimmed = name.trim();
  return extension && !trimmed.toLowerCase().endsWith(extension.toLowerCase())
    ? `${trimmed}${extension}`
    : trimmed;
}

export function resultDisplayName(source: unknown): string | null {
  if (source == null || typeof source !== "object") return null;
  const name = (source as Record<string, unknown>)["displayName"];
  return typeof name === "string" && name.trim() ? name : null;
}
