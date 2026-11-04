/** 本地分镜表。每个镜头有稳定身份，排序或修改正文不会改变它。 */
export interface ScriptShot {
  readonly id: string;
  readonly duration: string;
  readonly plot: string;
  readonly characters: string;
  readonly shotSize: string;
  readonly camera: string;
  readonly emotion: string;
  readonly scene: string;
  readonly props: string;
  readonly lighting: string;
  readonly sound: string;
  readonly dialogue: string;
  readonly imagePrompt: string;
  readonly videoPrompt: string;
  readonly imageToVideoPrompt: string;
  /** 用户明确绑定到该镜头的资产身份。 */
  readonly assetIds?: readonly string[];
  /** 模型返回了无法唯一对应资产的引用，需用户核对后清除。 */
  readonly unresolvedAssetRefs?: readonly string[];
  /** 生成提示词时的镜头与相关素材快照，用于提醒后续修改。 */
  readonly composedFrom?: string;
}

export interface ScriptAsset {
  readonly id: string;
  readonly kind: "character" | "scene" | "prop";
  readonly name: string;
  readonly description: string;
  /** 引用使用节点或本地素材身份，不用名称猜测。 */
  readonly reference?: { readonly kind: "canvas"; readonly sourceKey: string }
    | { readonly kind: "material"; readonly materialId: string } | null;
}

export type ScriptStep = "confirm-shots" | "prepare-assets" | "compose-prompts";

export type ScriptBatchKind = "image" | "video";
export type ScriptBatchFrame =
  | { readonly kind: "canvas"; readonly sourceKey: string }
  | { readonly kind: "result"; readonly taskId: string; readonly resultIndex: number };

export interface ScriptBatchItem {
  readonly id: string;
  readonly shotId: string;
  readonly shotNumber: number;
  readonly nodeKey: string;
  /** 已在本地持久化的任务身份，重复提交只返回同一个任务。 */
  readonly taskId: string;
  readonly shotFingerprint: string;
  readonly nodeFingerprint: string;
  readonly frame?: ScriptBatchFrame | null;
  readonly phase: "prepared" | "submitting" | "submitted" | "uncertain" | "blocked";
  readonly error: string | null;
  /** 与实际提交不一致的说明（例如镜头时长被夹到模型支持的档位）。 */
  readonly note?: string | null;
}

export interface ScriptBatchRun {
  readonly id: string;
  readonly kind: ScriptBatchKind;
  readonly createdAt: number;
  readonly providerId: string;
  readonly modelDefinitionId: string;
  readonly modelLabel: string;
  readonly providerFingerprint: string;
  readonly items: readonly ScriptBatchItem[];
}

export interface ScriptBatchStartRequest {
  readonly kind: ScriptBatchKind;
  readonly shotIds: readonly string[];
  readonly providerId: string;
  readonly modelDefinitionId: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly frames: Readonly<Record<string, ScriptBatchFrame>>;
  readonly useShotDuration: boolean;
}

export interface ScriptGeneratorState {
  readonly step: ScriptStep;
  readonly shots: readonly ScriptShot[];
  readonly assets: readonly ScriptAsset[];
  /** 批次与任务身份随画布保存，结果仍以任务历史为权威。 */
  readonly batches?: readonly ScriptBatchRun[];
  /** 每镜用户选用的首帧；只有一个可用结果时可自动使用。 */
  readonly frameSelections?: Readonly<Record<string, ScriptBatchFrame>>;
  /** 最近一次覆盖前的表格，供用户撤回一次重新生成。 */
  readonly previous?: {
    readonly shots: readonly ScriptShot[];
    readonly assets: readonly ScriptAsset[];
    /** 替换后的指纹；后续编辑过则不能用旧快照覆盖新内容。 */
    readonly afterFingerprint: string;
  };
}

const newId = () => crypto.randomUUID();

export function emptyScriptShot(): ScriptShot {
  return {
    id: newId(), duration: "5", plot: "", characters: "", shotSize: "", camera: "", emotion: "",
    scene: "", props: "", lighting: "", sound: "", dialogue: "", imagePrompt: "",
    videoPrompt: "", imageToVideoPrompt: "", assetIds: [],
  };
}

export function emptyScriptGenerator(): ScriptGeneratorState {
  return { step: "confirm-shots", shots: [], assets: [] };
}

export function scriptTableFingerprint(shots: readonly ScriptShot[], assets: readonly ScriptAsset[]): string {
  return JSON.stringify({ shots, assets });
}

export function replaceScriptTable(
  state: ScriptGeneratorState,
  shots: readonly ScriptShot[],
  assets: readonly ScriptAsset[] = state.assets,
): ScriptGeneratorState {
  return {
    ...state, shots, assets,
    previous: { shots: state.shots, assets: state.assets, afterFingerprint: scriptTableFingerprint(shots, assets) },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function field(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).join("、");
  return "";
}

/** 只接受完整的 JSON 合同；解析失败时调用方保留原始任务结果，不自动重发。 */
export function parseScriptGeneration(raw: string, existingAssets: readonly ScriptAsset[] = []): { shots: ScriptShot[]; assets: ScriptAsset[] } {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  let data: unknown;
  try {
    data = JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  } catch {
    throw new Error("模型没有返回可读取的分镜 JSON；原始结果已保存在任务历史中，可查看或复制后手动编辑。");
  }
  const object = record(data);
  if (!object || !Array.isArray(object["shots"]) || object["shots"].length === 0) {
    throw new Error("模型结果中没有分镜列表；原始结果已保存在任务历史中，可查看或复制后手动编辑。");
  }
  const shots = object["shots"].map((value) => {
    const item = record(value);
    if (!item) throw new Error("模型返回的分镜格式不完整；原始结果已保存在任务历史中。");
    return {
      ...emptyScriptShot(),
      duration: field(item["duration"]) || "5", plot: field(item["plot"]),
      characters: field(item["characters"]), shotSize: field(item["shotSize"]),
      camera: field(item["camera"]),
      emotion: field(item["emotion"]), scene: field(item["scene"]),
      props: field(item["props"]), lighting: field(item["lighting"]),
      sound: field(item["sound"]), dialogue: field(item["dialogue"]),
      imagePrompt: field(item["imagePrompt"]), videoPrompt: field(item["videoPrompt"]),
      imageToVideoPrompt: field(item["imageToVideoPrompt"]),
    };
  });
  if (!shots.some((shot) => shot.plot || shot.imagePrompt || shot.videoPrompt)) {
    throw new Error("模型返回的分镜没有可用内容；原始结果已保存在任务历史中。");
  }
  if (object["assets"] != null && !Array.isArray(object["assets"])) {
    throw new Error("模型返回的资产列表格式不正确；原始结果已保存在任务历史中。");
  }
  const refToAsset = new Map<string, string>();
  const duplicateRefs = new Set<string>();
  const boundAssets = existingAssets.filter(asset => asset.reference);
  const reusedAssetIds = new Set<string>();
  const assets = (Array.isArray(object["assets"]) ? object["assets"] : []).map((value): ScriptAsset => {
    const item = record(value);
    if (!item) throw new Error("模型返回的资产格式不完整；原始结果已保存在任务历史中。");
    const kind = item["kind"];
    const name = field(item["name"]);
    if (!name || (kind !== "character" && kind !== "scene" && kind !== "prop")) {
      throw new Error("模型返回的资产缺少名称或类型；原始结果已保存在任务历史中。");
    }
    const id = newId();
    const ref = field(item["ref"]);
    if (ref && refToAsset.has(ref)) { refToAsset.delete(ref); duplicateRefs.add(ref); }
    else if (ref && !duplicateRefs.has(ref)) refToAsset.set(ref, id);
    const bound = boundAssets.find(asset => asset.id === ref && asset.kind === kind && !reusedAssetIds.has(asset.id));
    if (bound) reusedAssetIds.add(bound.id);
    return { id, kind, name, description: field(item["description"]), ...(bound ? { reference: bound.reference } : {}) };
  });
  for (const asset of boundAssets) {
    if (reusedAssetIds.has(asset.id)) continue;
    assets.push(asset);
    if (!duplicateRefs.has(asset.id) && !refToAsset.has(asset.id)) refToAsset.set(asset.id, asset.id);
  }
  const rawShots = object["shots"] as unknown[];
  return { shots: shots.map((shot, index) => {
    const refs = record(rawShots[index])?.["assetRefs"];
    const assetIds: string[] = [];
    const unresolved: string[] = [];
    if (Array.isArray(refs)) {
      for (const value of refs) {
        const ref = typeof value === "string" ? value.trim() : "";
        const id = refToAsset.get(ref);
        if (id) assetIds.push(id);
        else unresolved.push(ref || "格式不正确");
      }
    } else if (refs != null) unresolved.push("格式不正确");
    else if (assets.length && (shot.characters || shot.scene || shot.props)) unresolved.push("未返回资产关联");
    const bound = { ...shot, assetIds: [...new Set(assetIds)],
      ...(unresolved.length ? { unresolvedAssetRefs: [...new Set(unresolved)] } : {}) };
    return { ...bound, composedFrom: scriptSourceSignature(bound, assets) };
  }), assets };
}

export function parseScriptComposition(raw: string, expectedIds: readonly string[]): ReadonlyMap<string, {
  imagePrompt: string; videoPrompt: string; imageToVideoPrompt: string;
}> {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  let data: unknown;
  try { data = JSON.parse(fenced?.[1] ?? trimmed) as unknown; }
  catch { throw new Error("模型没有返回可读取的提示词 JSON；原始结果可在任务历史中查看。"); }
  const object = record(data);
  if (!object || !Array.isArray(object["prompts"])) throw new Error("模型结果缺少提示词列表；原始结果可在任务历史中查看。");
  const expected = new Set(expectedIds);
  const prompts = new Map<string, { imagePrompt: string; videoPrompt: string; imageToVideoPrompt: string }>();
  for (const value of object["prompts"]) {
    const item = record(value);
    const id = item ? field(item["id"]) : "";
    if (!item || !expected.has(id) || prompts.has(id)) throw new Error("模型返回了无法对应的镜头编号；原始结果可在任务历史中查看。");
    const result = {
      imagePrompt: field(item["imagePrompt"]), videoPrompt: field(item["videoPrompt"]),
      imageToVideoPrompt: field(item["imageToVideoPrompt"]),
    };
    if (!result.imagePrompt && !result.videoPrompt && !result.imageToVideoPrompt) throw new Error("模型返回了空提示词；原始结果可在任务历史中查看。");
    prompts.set(id, result);
  }
  if (prompts.size !== expected.size) throw new Error("模型没有返回全部镜头的提示词；原始结果可在任务历史中查看。");
  return prompts;
}

/** 从本节点的已完成任务恢复结果，只读取历史，不重新提交模型请求。 */
export function restoreScriptTaskOutput(
  state: ScriptGeneratorState,
  logicalRequest: unknown,
  output: string,
): ScriptGeneratorState {
  const request = record(logicalRequest);
  if (request?.["scriptGenerator"] === true) {
    const parsed = parseScriptGeneration(output, state.assets);
    return { ...replaceScriptTable(state, parsed.shots, parsed.assets), step: "confirm-shots" };
  }
  if (!request || request["scriptPromptCompose"] !== true || typeof request["userPrompt"] !== "string") {
    throw new Error("所选任务不是此节点的分镜生成或提示词合成任务。");
  }
  let input: unknown;
  try { input = JSON.parse(request["userPrompt"]) as unknown; }
  catch { throw new Error("历史任务的镜头输入无法读取，请查看任务详情。"); }
  const inputRecord = record(input);
  const archivedShots = inputRecord?.["shots"];
  if (!Array.isArray(archivedShots)) throw new Error("历史任务没有可恢复的镜头身份。");
  const ids = archivedShots.map((shot) => field(record(shot)?.["id"]));
  if (!ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length ||
    ids.some((id) => !state.shots.some((shot) => shot.id === id))) {
    throw new Error("历史任务对应的镜头已删除或发生变化，不能自动写回；请查看任务详情复制结果。");
  }
  const prompts = parseScriptComposition(output, ids);
  const shots = state.shots.map((shot) => {
    const result = prompts.get(shot.id);
    // 历史结果可能来自旧版镜头；强制提示重新核对输入和资产，不冒充当前合成结果。
    return result ? { ...shot, ...result, composedFrom: "historical-output-needs-review" } : shot;
  });
  return { ...replaceScriptTable(state, shots), step: "compose-prompts" };
}

/** 只纳入用户明确绑定的资产，不凭显示名猜测素材身份。 */
export function matchingScriptAssets(shot: ScriptShot, assets: readonly ScriptAsset[]): readonly ScriptAsset[] {
  const ids = new Set(shot.assetIds ?? []);
  return assets.filter((asset) => ids.has(asset.id));
}

export function scriptSourceSignature(shot: ScriptShot, assets: readonly ScriptAsset[]): string {
  return JSON.stringify({
    duration: shot.duration, plot: shot.plot, characters: shot.characters, shotSize: shot.shotSize, camera: shot.camera,
    emotion: shot.emotion, scene: shot.scene, props: shot.props, lighting: shot.lighting,
    sound: shot.sound, dialogue: shot.dialogue, assetIds: shot.assetIds ?? [], unresolvedAssetRefs: shot.unresolvedAssetRefs ?? [],
    assets: matchingScriptAssets(shot, assets).map(({ id, kind, name, description, reference }) => ({
      id, kind, name, description, reference: reference ?? null,
    })),
  });
}

/** 手写镜头可完全在本地拼接提示词；不会调用模型或提交媒体生成任务。 */
export function composeScriptShot(shot: ScriptShot, assets: readonly ScriptAsset[]): ScriptShot {
  const parts: readonly [string, string][] = [
    ["画面与动作", shot.plot], ["角色", shot.characters], ["景别", shot.shotSize], ["运镜", shot.camera],
    ["情绪", shot.emotion], ["场景", shot.scene], ["道具", shot.props], ["光线氛围", shot.lighting],
  ];
  const base = parts.filter(([, value]) => value.trim()).map(([label, value]) => `${label}：${value.trim()}`);
  const references = matchingScriptAssets(shot, assets).filter((asset) => asset.description.trim())
    .map((asset) => `${asset.name}：${asset.description.trim()}`);
  const visual = [...base, ...references].join("；");
  const audio = [["对白", shot.dialogue], ["音效", shot.sound]]
    .filter(([, value]) => value?.trim()).map(([label, value]) => `${label}：${value!.trim()}`).join("；");
  const durationText = shot.duration.trim();
  const duration = durationText ? `时长：${/秒|s$/i.test(durationText) ? durationText : `${durationText} 秒`}` : "";
  return {
    ...shot,
    imagePrompt: visual,
    videoPrompt: [visual, audio, duration].filter(Boolean).join("；"),
    imageToVideoPrompt: [shot.plot.trim(), shot.camera.trim(), audio, duration].filter(Boolean).join("；"),
    composedFrom: scriptSourceSignature(shot, assets),
  };
}

/** 输出同一份可编辑表格的 Markdown 镜像，供现有连线和导出通道消费。 */
export function scriptDocument(state: ScriptGeneratorState): string {
  if (!state.shots.length && !state.assets.length) return "";
  const sections = ["# 分镜脚本"];
  state.shots.forEach((shot, index) => {
    const lines = [`## 镜头 ${index + 1}`];
    const values: readonly [string, string][] = [
      ["时长", shot.duration], ["剧情画面", shot.plot], ["角色", shot.characters],
      ["景别", shot.shotSize], ["运镜", shot.camera], ["情绪", shot.emotion], ["场景", shot.scene],
      ["道具", shot.props], ["光线氛围", shot.lighting], ["音效", shot.sound],
      ["对白", shot.dialogue], ["图片提示词", shot.imagePrompt], ["视频提示词", shot.videoPrompt],
      ["图生视频提示词", shot.imageToVideoPrompt],
    ];
    for (const [label, value] of values) if (value.trim()) lines.push(`**${label}：** ${value.trim()}`);
    sections.push(lines.join("\n\n"));
  });
  if (state.assets.length) {
    const labels = { character: "角色", scene: "场景", prop: "道具" } as const;
    sections.push(`## 素材清单\n\n${state.assets.map((asset) => `- ${labels[asset.kind]}：${asset.name}${asset.description ? ` — ${asset.description}` : ""}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

