/** Persist JSON inputs independently of object insertion order; array order remains meaningful. */
export function stableJsonSignature(value: unknown): string {
  const result = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
  if (result === undefined) throw new TypeError("工作流输入必须是可保存的 JSON 数据。");
  return result;
}

/** Legacy signatures contain ordinary JSON.stringify output and must remain resumable. */
export function sameWorkflowSignature(previous: string | undefined, current: string): boolean {
  if (previous === current) return true;
  if (!previous) return false;
  try {
    return (
      stableJsonSignature(JSON.parse(previous) as unknown) ===
      stableJsonSignature(JSON.parse(current) as unknown)
    );
  } catch {
    return false;
  }
}
