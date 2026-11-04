/*
 * 创作台的会话层：把「选模型 → 填参数 → 提交 → 看结果」接到本项目自有 API 上。
 *
 * 数据来源全部是项目已有的后端能力，没有新端点：
 *   - loadGenerationModelCatalog()   已接入的供应商、模型与参数能力表
 *   - modelParameterCapabilities()   模型声明的参数能力（比例/分辨率/数量/时长…）
 *   - generationClient.start()       提交生成
 *   - textGenerationClient.start()   提交文本生成（走文本模型通道，不走媒体任务管线）
 *   - generationClient.list()        历史记录（按创作台专属 canvasId 归档）
 *   - generationClient.getProgress()  任务状态：状态 + 产物 + 提示词快照
 *
 * 刷新与轮询**只走状态轻量接口**：`get()` 是诊断详情，会把每次供应商调用的
 * 完整请求体与原始响应体一并带回来（一次图片调用就是几 MB 整包 base64，
 * 一个视频任务有几十次调用）。在生成期间每 1.5~6 秒拉一轮详情，等于让几十 MB
 * 报文反复穿过 IPC 边界，界面会卡住、生成键也解不开。
 *
 * 轮询节奏是刻意压短的：提交后 1.2 秒起，以 1.5 秒为基准递增到 6 秒封顶。
 * 依据是即梦创作页的实测——它声明的轮询配置是 30 秒，实际客户端却按
 * 5~13 秒在轮。用户等一张图的那几十秒里，多等 20 秒是能被感知的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExplicitMediaInput,
  GenerationOperation,
  GenerationTaskStatus,
  MediaReferenceTarget,
  MediaLibraryKind,
  ModelOperationSchema,
  PromptSegment,
} from "../../lib/backend";
import { generationClient, loadGenerationModelCatalog, textGenerationClient } from "../../lib/backend";
import {
  generationParameters,
  modelParameterCapabilities,
  modelSupportsBatchCount,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import {
  CREATE_CANVAS_ID,
  CREATE_SOURCE_NODE_ID,
  describeRecordParameters,
  isLiveStatus,
} from "./createModel";

export interface CreateModelOption {
  readonly providerConnectionId: string;
  readonly providerName: string;
  readonly modelDefinitionId: string;
  readonly remoteModelId: string;
  readonly displayName: string;
  readonly operations: readonly GenerationOperation[];
  readonly operationSchema: ModelOperationSchema;
}

export interface CreateResultItem {
  readonly taskId: string;
  readonly resultIndex: number;
  readonly mediaType: string;
  /** 本地落盘路径；优先用它显示，失败时回退到远端地址。 */
  readonly finalPath: string | null;
  /** 远端产物地址（供应商返回的原始链接）。 */
  readonly remoteUrl: string | null;
  readonly saveStatus: string;
  readonly error: unknown;
}

export interface CreateRecord {
  readonly taskId: string;
  readonly status: GenerationTaskStatus;
  readonly prompt: string;
  readonly modelName: string;
  readonly operation: GenerationOperation;
  readonly createdAt: number;
  readonly results: readonly CreateResultItem[];
  /**
   * 文本任务的回答正文。
   *
   * 文本生成没有媒体产物，正文就是交付物；媒体任务这里是 null。
   */
  readonly textOutput: string | null;
  readonly error: unknown;
  /** 本次任务应有的产物数（来自提交时的数量参数），用于生成中占位。 */
  readonly expectedCount: number;
  /**
   * 这次提交用的参数摘要（比例、分辨率、数量…）。
   *
   * 即梦的记录抬头就是「提示词 · 模型 · 比例 · 分辨率」，没有它就只有提示词和
   * 模型两项。值来自任务详情里的 logicalRequest.parameters——那是提交时的快照，
   * 换模型改参数后历史记录也不会被改写。
   */
  readonly parameterLabels: readonly string[];
  /**
   * 这次提交用的参考素材（从任务详情的 logicalRequest.explicitMedia 还原）。
   *
   * 「再次生成」必须用**原任务的**参考素材，而不是空数组：之前硬编码
   * `references: []` → 用户点「再次生成」后参考图/参考视频全消失，产出的是
   * 纯文生结果 —— 而**照样扣费**。用户以为「重跑一遍」，实际换了输入。
   */
  readonly references: readonly CreateReference[];
}

export interface CreateReference {
  /**
   * 参考素材的来源。
   *
   * 三种来源对应后端三种合法 target：
   *   - `local_file`         本机文件（文件选择器选出来的）
   *   - `asset`              云端素材库素材（必须带 providerConnectionId）
   *   - `local_base64_asset` 本机 Base64 素材库素材
   *
   * 之前这里只有「路径」一种形状，于是云端素材根本进不了创作台：后端只认
   * 素材身份（assetId + providerConnectionId），拿签名 URL 去请求会绕过凭据
   * 冻结，供应商侧也会因为没有素材 ID 而拒绝。
   */
  readonly kind: CreateReferenceKind;
  readonly name: string;
  /**
   * 真实媒体类型。
   *
   * 它决定后端走哪条读取通道：图片按图片读、视频按视频读。
   * 之前硬编码成 "image"，素材库里的视频素材会被当图片读——要么失败，
   * 要么被静默忽略，表现为「传了参考但模型没当条件」。
   */
  readonly mediaType: MediaLibraryKind;
  /** `local_file` 专有：本机绝对路径。 */
  readonly path?: string;
  /** `asset` / `local_base64_asset` 专有：素材 ID。 */
  readonly assetId?: string;
  /** `asset` 专有：云端素材所属的供应商连接。 */
  readonly providerConnectionId?: string;
  /** 缩略图地址；用于参考条上那张小卡。 */
  readonly previewUrl?: string | null;
}

export type CreateReferenceKind = "local_file" | "asset" | "local_base64_asset";

/**
 * 参考素材 → 后端的显式媒体目标。
 *
 * 形状必须与 `MediaReferenceTarget` 的判别联合一一对应，不能自造字段。
 */
export function referenceTargetOf(reference: CreateReference): MediaReferenceTarget {
  if (reference.kind === "asset" && reference.assetId && reference.providerConnectionId) {
    return {
      kind: "asset",
      providerConnectionId: reference.providerConnectionId,
      assetId: reference.assetId,
      mediaType: reference.mediaType,
    };
  }
  if (reference.kind === "local_base64_asset" && reference.assetId) {
    return {
      kind: "local_base64_asset",
      assetId: reference.assetId,
      mediaType: reference.mediaType,
    };
  }
  return { kind: "local_file", path: reference.path ?? "", mediaType: reference.mediaType };
}

/**
 * 参考素材的角色。
 *
 * 与后端 `media.rs` 的归一表保持一致：图片 → reference_image、
 * 视频 → reference_video、音频 → reference_audio。后端会按 mediaType 再校正一次，
 * 这里先给对，是为了让前端预览与后端入库的顺序一致。
 */
export function referenceRoleOf(mediaType: MediaLibraryKind): string {
  if (mediaType === "video") return "reference_video";
  if (mediaType === "audio") return "reference_audio";
  return "reference_image";
}

/**
 * 从任务详情的 logicalRequest 把参考素材还原出来。
 *
 * 「再次生成」要用**原任务的**参考素材：之前硬编码 `references: []`，
 * 用户点一次「再次生成」参考图/视频全消失、产出变成纯文生结果，**照样扣费**。
 *
 * `logicalRequest.explicitMedia` 是提交时的快照（提交那一刻的 target 与角色），
 * 所以能还原出三种合法来源里的两种（云端素材 / 本机 Base64 素材）；
 * 本机文件因为快照里只存了路径，也能还原。
 */
function referencesOfDetail(detail: { readonly logicalRequest?: unknown }): readonly CreateReference[] {
  const logical = detail.logicalRequest as
    | {
        explicitMedia?: readonly ExplicitMediaInput[];
        referenceInputs?: readonly { readonly target?: unknown; readonly displayName?: string }[];
      }
    | null
    | undefined;
  const references: CreateReference[] = [];
  const media = logical?.explicitMedia;
  if (Array.isArray(media)) {
    for (const item of media) {
      const reference = referenceFromTarget(item?.target, item?.displayNameSnapshot ?? "");
      if (reference) references.push(reference);
    }
    return references;
  }
  // 文本生成的快照是 `referenceInputs`：只记素材身份，不含素材正文。
  const inputs = logical?.referenceInputs;
  if (Array.isArray(inputs)) {
    for (const item of inputs) {
      const reference = referenceFromTarget(item?.target, item?.displayName ?? "");
      if (reference) references.push(reference);
    }
  }
  return references;
}

/** 素材目标 → 创作台的参考素材形状。 */
function referenceFromTarget(target: unknown, name: string): CreateReference | null {
  if (target == null || typeof target !== "object") return null;
  const record = target as Record<string, unknown>;
  const kind = record["kind"];
  const mediaType = record["mediaType"];
  if (typeof mediaType !== "string") return null;
  const kindOfMedia = mediaType as MediaLibraryKind;
  if (kind === "asset") {
    const assetId = record["assetId"];
    const providerConnectionId = record["providerConnectionId"];
    if (typeof assetId !== "string" || typeof providerConnectionId !== "string") return null;
    return { kind: "asset", name, mediaType: kindOfMedia, assetId, providerConnectionId };
  }
  if (kind === "local_base64_asset") {
    const assetId = record["assetId"];
    if (typeof assetId !== "string") return null;
    return { kind: "local_base64_asset", name, mediaType: kindOfMedia, assetId };
  }
  if (kind === "local_file") {
    const path = record["path"];
    if (typeof path !== "string") return null;
    return { kind: "local_file", name, mediaType: kindOfMedia, path };
  }
  return null;
}

export interface CreateSession {
  readonly models: readonly CreateModelOption[];
  readonly modelsLoading: boolean;
  readonly modelsError: unknown;
  readonly records: readonly CreateRecord[];
  /** 渲染用的时间基准（毫秒时间戳）；0 表示尚未完成首次刷新。 */
  readonly now: number;
  readonly submitting: boolean;
  readonly submitError: unknown;
  readonly submit: (input: CreateSubmitInput) => Promise<void>;
  /**
   * 取消在途任务。
   *
   * 之前创作台**没有取消入口**：后端 `cancel_generation_task` 已注册、前端封装
   * 已存在，只有任务历史面板在用 → 创作台提交的任务无法中止，用户只能干等
   * （或去另一个窗口的历史面板找）。
   */
  readonly cancel: (taskId: string) => Promise<void>;
  /** 取消失败的原因（供界面提示）。 */
  readonly cancelError: unknown;
  readonly refresh: () => Promise<void>;
  /** 重新拉取模型目录（供应商与模型配置变更后调用）。 */
  readonly reloadModels: () => Promise<void>;
}

export interface CreateSubmitInput {
  readonly operation: GenerationOperation;
  readonly model: CreateModelOption;
  readonly prompt: string;
  readonly references: readonly CreateReference[];
  readonly parameters: Readonly<Record<string, ModelParameterValue>>;
}

/** 结果记录里的远端地址：后端在不同供应商下给的形状不统一，这里只认 URL 字符串。 */
function remoteUrlOf(source: unknown): string | null {
  if (typeof source === "string") return source.startsWith("http") ? source : null;
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    for (const key of ["url", "uri", "image_url", "video_url"]) {
      const value = record[key];
      if (typeof value === "string" && value.startsWith("http")) return value;
    }
  }
  return null;
}

function toResultItems(detail: {
  readonly results?: readonly unknown[];
}): readonly CreateResultItem[] {
  return (detail.results ?? []).map((raw, index) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    return {
      taskId: typeof record["taskId"] === "string" ? record["taskId"] : "",
      resultIndex: typeof record["resultIndex"] === "number" ? record["resultIndex"] : index,
      mediaType: typeof record["mediaType"] === "string" ? record["mediaType"] : "image",
      finalPath: typeof record["finalPath"] === "string" ? record["finalPath"] : null,
      remoteUrl: remoteUrlOf(record["source"]),
      saveStatus: typeof record["saveStatus"] === "string" ? record["saveStatus"] : "unknown",
      error: record["error"] ?? null,
    };
  });
}

/** 从任务详情里取出「这次用了什么提示词」，用于结果卡片的抬头。 */
function promptOfDetail(detail: { readonly logicalRequest?: unknown }): string {
  const request = detail.logicalRequest;
  if (!request || typeof request !== "object") return "";
  const record = request as Record<string, unknown>;
  const prompt = record["prompt"];
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((segment) => {
        if (!segment || typeof segment !== "object") return "";
        const item = segment as Record<string, unknown>;
        return item["kind"] === "text" && typeof item["text"] === "string" ? item["text"] : "";
      })
      .join("")
      .trim();
  }
  // 文本生成走的是文本命令（`StartTextGenerationCommand`），提示词在 userPrompt。
  const userPrompt = record["userPrompt"];
  return typeof userPrompt === "string" ? userPrompt : "";
}

/**
 * 按能力表把参数值补全成可直接提交的形状。
 *
 * 关键约束（来自项目既有约定）：后端与远端说了算。
 * 能力表里声明为必填的参数一律带上默认值；用户显式改过的值优先，
 * 不能被默认值悄悄覆盖。
 */
export function buildSubmitParameters(
  capabilities: readonly ModelParameterCapability[],
  values: Readonly<Record<string, ModelParameterValue>>,
  hasMedia: boolean,
): Record<string, ModelParameterValue> {
  return generationParameters(capabilities, values, hasMedia);
}

/** 模型是否支持一次性出多张（`n` 参数）。不支持时数量要拆成多次任务。 */
export function supportsBatchCount(
  operationSchema: ModelOperationSchema,
  operation: GenerationOperation,
  remoteModelId: string,
): boolean {
  return modelSupportsBatchCount(operationSchema, operation, remoteModelId);
}

function pollDelayMs(attempt: number): number {
  return Math.min(6000, 1500 + attempt * 750);
}

export function useCreateSession(): CreateSession {
  const [models, setModels] = useState<readonly CreateModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [records, setRecords] = useState<readonly CreateRecord[]>([]);
  /*
   * 「现在」的时间基准。渲染期不能调 Date.now()（渲染必须是纯函数），
   * 所以由刷新流程在异步回调里取一次，随记录一起下发。
   * 首次刷新完成前没有记录，因此不会出现日期标签闪一下再变的情况。
   */
  const [now, setNow] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const liveTasks = useRef(new Set<string>());
  /** 轮询退避计数：任务全部结束后归零。 */
  const pollAttempt = useRef(0);

  /*
   * 加载模型。初始状态已经是 loading，这里不再重复置位——
   * 副作用里同步改状态会多触发一轮渲染（React 官方明确不建议）。
   */
  const loadModels = useCallback(async () => {
    try {
      /*
       * 模型目录一次拿齐：服务端同时下发「模型 + 该模型声明的参数能力表」。
       * 参数范围与枚举因此由服务端说了算，前端只按声明渲染，
       * 不再自己按模型名推断（也不必分三次查询再拼装）。
       */
      const catalog = await loadGenerationModelCatalog();
      const options: CreateModelOption[] = catalog
        .filter((model) => model.operations.length > 0)
        .map((model) => ({
          providerConnectionId: model.providerConnectionId,
          providerName: model.providerDisplayName,
          modelDefinitionId: model.modelDefinitionId,
          remoteModelId: model.remoteModelId,
          displayName: model.displayName,
          operations: model.operations,
          operationSchema: model.operationSchema,
        }));
      setModels(options);
      setModelsError(null);
    } catch (error) {
      setModelsError(error);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const page = await generationClient.list({ canvasId: CREATE_CANVAS_ID, limit: 50 });
      const details = await Promise.all(page.items.map((item) => generationClient.getProgress(item.id)));
      const next: CreateRecord[] = details.map((detail) => {
        const summary = detail.summary;
        const expected = countExpected(detail);
        return {
          taskId: summary.id,
          status: summary.status,
          prompt: promptOfDetail(detail),
          modelName: summary.remoteModelIdSnapshot ?? summary.modelDefinitionId,
          operation: summary.operation,
          createdAt: summary.createdAt,
          results: toResultItems(detail),
          textOutput: detail.textOutput?.optimizedPrompt ?? null,
          error: detail.finalError ?? null,
          expectedCount: expected,
          parameterLabels: describeRecordParameters(detail),
          references: referencesOfDetail(detail),
        };
      });
      next.sort((left, right) => right.createdAt - left.createdAt);
      setRecords(next);
      setNow(Date.now());
      for (const item of next) {
        if (isLiveStatus(item.status)) liveTasks.current.add(item.taskId);
        else liveTasks.current.delete(item.taskId);
      }
    } catch {
      // 列表刷新失败不打断界面：已有记录继续可用，下一轮再试。
    }
  }, []);

  useEffect(() => {
    /*
     * 推迟一拍再拉取。副作用里直接调用会改状态的函数会多触发一轮渲染
     * （React 官方明确不建议），放到定时器回调里就没有这个问题。
     */
    const timer = window.setTimeout(() => {
      void loadModels();
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadModels, refresh]);

  /*
   * 在途任务单独轮询。
   *
   * 节奏刻意压短：起始 1.5 秒，每轮 +0.75 秒，上限 6 秒。依据是即梦创作页的
   * 实测——它声明的轮询配置是 30 秒，实际客户端却按 5~13 秒在轮。用户等一张图
   * 的那几十秒里，多等 20 秒是能被感知的。
   *
   * 退避计数放在 ref 里：任务全部结束后归零，下一次提交立刻回到快节奏。
   */
  useEffect(() => {
    if (liveTasks.current.size === 0) {
      pollAttempt.current = 0;
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const ids = [...liveTasks.current];
      await Promise.all(
        ids.map(async (taskId) => {
          try {
            const detail = await generationClient.getProgress(taskId);
            if (cancelled) return;
            setRecords((previous) =>
              previous.map((record) =>
                record.taskId === taskId
                  ? {
                      ...record,
                      status: detail.summary.status,
                      results: toResultItems(detail),
                      textOutput: detail.textOutput?.optimizedPrompt ?? null,
                      error: detail.finalError ?? null,
                      expectedCount: countExpected(detail),
                    }
                  : record,
              ),
            );
            if (!isLiveStatus(detail.summary.status)) liveTasks.current.delete(taskId);
          } catch {
            // 单次拉取失败不终止轮询，等下一拍。
          }
        }),
      );
      if (cancelled) return;
      pollAttempt.current += 1;
      if (liveTasks.current.size === 0) pollAttempt.current = 0;
      await refresh();
    };

    const timer = window.setTimeout(() => {
      void poll();
    }, pollDelayMs(pollAttempt.current));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [records, refresh]);

  const submit = useCallback(
    async (input: CreateSubmitInput) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        /*
         * 文本生成不走媒体任务管线。
         *
         * 管线里 `text_generation` 是被显式拦掉的（文本模型不走图片/视频的请求
         * 构造），所以创作台的「文本生成」必须走文本通道：建任务 → 后台执行 →
         * 立刻返回任务 ID → 前端按任务轮询。这样它才有产物、才进生成历史，
         * 也不会把提交按钮按住几十秒。
         */
        if (input.operation === "text_generation") {
          const taskId = await textGenerationClient.start({
            canvasId: CREATE_CANVAS_ID,
            sourceNodeId: CREATE_SOURCE_NODE_ID,
            providerConnectionId: input.model.providerConnectionId,
            modelDefinitionId: input.model.modelDefinitionId,
            userPrompt: input.prompt,
            referenceInputs: input.references.map((reference) => ({
              target: referenceTargetOf(reference),
              displayName: reference.name,
            })),
          });
          liveTasks.current.add(taskId);
          await refresh();
          return;
        }
        const capabilities = modelParameterCapabilities(
          input.model.operationSchema,
          input.operation,
          input.model.remoteModelId,
        );
        const parameters = buildSubmitParameters(
          capabilities,
          input.parameters,
          input.references.length > 0,
        );
        const promptSegments: PromptSegment[] = [{ kind: "text", text: input.prompt }];
        const explicitMedia: ExplicitMediaInput[] = input.references.map((reference, index) => ({
          target: referenceTargetOf(reference),
          role: referenceRoleOf(reference.mediaType),
          displayNameSnapshot: reference.name,
          // 同类序号（「图片1」「图片2」）与全局序号（content 数组顺序）都要给：
          // 前者决定提示词里的 @ 编号，后者决定素材进模型的先后。
          typePosition: index + 1,
          contentIndex: index + 1,
        }));
        const command = {
          canvasId: CREATE_CANVAS_ID,
          sourceNodeId: CREATE_SOURCE_NODE_ID,
          operation: input.operation,
          providerConnectionId: input.model.providerConnectionId,
          modelDefinitionId: input.model.modelDefinitionId,
          prompt: promptSegments,
          parameters,
          ...(explicitMedia.length > 0 ? { explicitMedia } : {}),
        };
        const taskId = await generationClient.start(command);
        liveTasks.current.add(taskId);
        await refresh();
      } catch (error) {
        setSubmitError(error);
      } finally {
        setSubmitting(false);
      }
    },
    [refresh],
  );

  const cancel = useCallback(
    async (taskId: string) => {
      setCancelError(null);
      try {
        await generationClient.cancel(taskId);
        liveTasks.current.delete(taskId);
        await refresh();
      } catch (error) {
        // 取消失败要看得见：可能是任务已经结束（竞态），也可能是真的没取消掉。
        setCancelError(error);
        await refresh();
      }
    },
    [refresh],
  );

  return useMemo(
    () => ({
      models,
      modelsLoading,
      modelsError,
      records,
      now,
      submitting,
      submitError,
      submit,
      cancel,
      cancelError,
      refresh,
      reloadModels: loadModels,
    }),
    [
      models,
      modelsLoading,
      modelsError,
      records,
      now,
      submitting,
      submitError,
      submit,
      cancel,
      cancelError,
      refresh,
      loadModels,
    ],
  );
}

/** 本次任务应有的产物数：优先看请求里的数量参数，其次看已有产物数。 */
function countExpected(detail: { readonly logicalRequest?: unknown }): number {
  const request = detail.logicalRequest;
  if (request && typeof request === "object") {
    const parameters = (request as Record<string, unknown>)["parameters"];
    if (parameters && typeof parameters === "object") {
      const n = (parameters as Record<string, unknown>)["n"];
      if (typeof n === "number" && n > 0) return Math.trunc(n);
    }
  }
  return 0;
}
