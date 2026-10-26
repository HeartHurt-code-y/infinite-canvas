import type { ModelParameterCapability, ModelParameterValue } from "./modelCapabilities";
import {
  createPromptContentEditorSession,
  decodePromptContentDocument,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptContentItem,
  type PromptGenerationPreparation,
} from "./promptContent";

export const PANORAMA_ASPECT_MIN = 1.7;
export const PANORAMA_INSTRUCTION =
  "生成一张无人物的 equirectangular 360° 全景环境图，左右边缘无缝衔接，电影级光影与空间纵深，空镜场景，不要出现人物、文字、水印、界面元素。";

const PANORAMA_SIZE_KEYS = ["size", "ratio", "aspect_ratio"] as const;
const PANORAMA_SIZE_PREFERENCE = ["21:9", "2:1", "2848x1600", "1792x1024", "1536x1024", "16:9"];

const emptyDocument = (): PromptContentDocumentV1 => ({
  schema: "prompt-content",
  version: 1,
  items: [],
});

export function isPanoramaAspect(width: number, height: number): boolean {
  return height > 0 && width / height >= PANORAMA_ASPECT_MIN;
}

export function documentHasPanoramaInstruction(
  document: PromptContentDocumentV1 | undefined,
): boolean {
  if (!document) return false;
  const text = document.items.map((item) => (item.kind === "text" ? item.text : "")).join("");
  return /equirectangular|全景环境图|360\s*°?\s*全景/iu.test(text);
}

export function appendPanoramaInstruction(
  document: PromptContentDocumentV1 | undefined,
): PromptContentDocumentV1 {
  const previous = document ?? emptyDocument();
  if (documentHasPanoramaInstruction(previous)) return previous;
  const items: PromptContentItem[] = [...previous.items];
  const needsBreak = items.some((item) => item.kind === "text" && item.text.trim());
  if (needsBreak) items.push({ kind: "text", text: "\n\n" });
  items.push({ kind: "text", text: PANORAMA_INSTRUCTION });
  return { schema: "prompt-content", version: 1, items };
}

export function preferredPanoramaParameters(
  capabilities: readonly ModelParameterCapability[],
): Readonly<Record<string, ModelParameterValue>> {
  const patch: Record<string, ModelParameterValue> = {};
  for (const key of PANORAMA_SIZE_KEYS) {
    const capability = capabilities.find((entry) => entry.key === key);
    if (!capability) continue;
    const match = PANORAMA_SIZE_PREFERENCE.find((value) =>
      capability.options.some((option) => String(option.value) === value),
    );
    if (!match) continue;
    const option = capability.options.find((entry) => String(entry.value) === match);
    if (option) patch[key] = option.value;
  }
  return patch;
}

export function preparePanoramaGeneration(
  previousDocument: PromptContentDocumentV1 | undefined,
  connections: readonly PromptContentConnection[],
  allowMediaOnly: boolean,
): { readonly issue: string | null; readonly preparation: PromptGenerationPreparation | null } {
  const previous = previousDocument ?? emptyDocument();
  if (!decodePromptContentDocument(previous)) {
    return { issue: "原提示内容格式无效，请检查提示词后重试。", preparation: null };
  }
  const session = createPromptContentEditorSession();
  session.restore(appendPanoramaInstruction(previous));
  try {
    return {
      issue: null,
      preparation: session.prepareGeneration({ connections, allowMediaOnly }),
    };
  } finally {
    session.attach(null);
  }
}
