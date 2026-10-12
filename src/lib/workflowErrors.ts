function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseResponse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function redact(value: string): string {
  return value
    .replace(
      /("(?:api[_-]?key|access[_-]?token|authorization|token|password|secret)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi,
      "$1<REDACTED>$3",
    )
    .replace(/(\bToken[A-Za-z]*\[)[^\]]*(\])/gi, "$1<REDACTED>$2")
    .replace(/\bBearer\s+[^\s"',;<>[\]{}]+/gi, "Bearer <REDACTED>")
    .replace(/\bsk-[A-Za-z0-9_*.-]+/g, "<REDACTED>")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*["']?)[^\s"',;<>[\]{}]+/gi,
      "$1<REDACTED>",
    )
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi, "$1<REDACTED>");
}

export type WorkflowErrorCode =
  | "approval"
  | "input_changed"
  | "requirements"
  | "model_configuration"
  | "materials"
  | "task_pending"
  | "task_identity"
  | "plan"
  | "output_invalid"
  | "storage"
  | "runtime"
  | "download"
  | "review"
  | "composition"
  | "unknown";

export interface WorkflowErrorPresentation {
  readonly origin: "workflow" | "model";
  readonly summary: string;
  readonly cause: string | null;
  readonly action: string | null;
  readonly steps: readonly string[];
  readonly prevention: string | null;
  readonly details: string | null;
}

const ERROR_PREFIX = "workflow-error:v1:";

class WorkflowModelError extends Error {
  constructor(readonly original: unknown) {
    super(formatWorkflowError(original), { cause: original });
    this.name = "WorkflowModelError";
  }
}

class WorkflowUsageError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkflowUsageError";
  }
}

/** Mark the remote call boundary, rather than guessing origin from words such as “模型”. */
export function modelWorkflowError(error: unknown): Error {
  return error instanceof WorkflowModelError ? error : new WorkflowModelError(error);
}

export function workflowUsageError(
  code: WorkflowErrorCode,
  message: string,
  cause?: unknown,
): Error {
  return new WorkflowUsageError(code, message, cause);
}

/** Only listed remote methods are decorated. Local persistence, decoding and recovery stay local. */
export function withWorkflowModelErrors<T extends object>(
  client: T,
  methods: readonly (keyof T)[],
): T {
  const selected = new Set<PropertyKey>(methods);
  return new Proxy(client, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const invoke = () => Reflect.apply(method, target, args) as unknown;
        if (!selected.has(property)) return invoke();
        try {
          return Promise.resolve(invoke()).catch((error: unknown) => {
            if (isCancellation(error) || markedError(error)?.origin === "workflow") throw error;
            const usage = backendUsageFailure(error);
            if (usage) throw usage;
            throw modelWorkflowError(error);
          });
        } catch (error) {
          if (isCancellation(error) || markedError(error)?.origin === "workflow") throw error;
          const usage = backendUsageFailure(error);
          if (usage) throw usage;
          throw modelWorkflowError(error);
        }
      };
    },
  });
}

function isCancellation(error: unknown): boolean {
  return record(error)?.["name"] === "AbortError";
}

/** Keep complete response fields and stack traces, redacting credentials as in the existing formatter. */
function completeError(error: unknown): string {
  if (typeof error === "string") return redact(error);
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(
    error,
    (_key: string, value: unknown): unknown => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string") return redact(value);
      if (value == null || typeof value !== "object") return value;
      if (seen.has(value)) return "[循环引用]";
      seen.add(value);
      if (Array.isArray(value)) return value;
      const payload =
        value instanceof Error
          ? {
              ...value,
              name: value.name,
              message: value.message,
              stack: value.stack,
              cause: value.cause,
            }
          : value;
      return Object.fromEntries(
        Object.entries(payload).map(([key, field]) => [
          key,
          /^(?:authorization|api[_-]?key|access[_-]?token|token|password|secret)$/i.test(key)
            ? "<REDACTED>"
            : field,
        ]),
      );
    },
    2,
  );
  return redact(serialized ?? "未收到错误详情");
}

interface PersistedWorkflowError {
  readonly origin: "workflow" | "model";
  readonly message: string;
  readonly raw: string;
  readonly code?: WorkflowErrorCode;
}

function persistedError(value: unknown): PersistedWorkflowError | null {
  if (typeof value !== "string" || !value.startsWith(ERROR_PREFIX)) return null;
  const parsed = record(parseResponse(value.slice(ERROR_PREFIX.length)));
  if (
    !parsed ||
    (parsed["origin"] !== "workflow" && parsed["origin"] !== "model") ||
    typeof parsed["message"] !== "string" ||
    typeof parsed["raw"] !== "string"
  )
    return null;
  return {
    origin: parsed["origin"],
    message: redact(parsed["message"]),
    raw: redact(parsed["raw"]),
    ...(typeof parsed["code"] === "string" && Object.hasOwn(GUIDANCE, parsed["code"])
      ? { code: parsed["code"] as WorkflowErrorCode }
      : {}),
  };
}

/** Retry wrappers retain causes; walk them so final persistence does not erase remote evidence. */
function markedError(error: unknown): PersistedWorkflowError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const persisted = persistedError(current) ?? persistedError(record(current)?.["message"]);
    if (persisted) return persisted;
    if (current instanceof WorkflowModelError) {
      return {
        origin: "model",
        message: formatWorkflowError(current.original),
        raw: completeError(current.original),
      };
    }
    if (current instanceof WorkflowUsageError) {
      return {
        origin: "workflow",
        code: current.code,
        message: current.message,
        raw: completeError(current),
      };
    }
    current = record(current)?.["cause"] ?? record(current)?.["original"];
  }
  return null;
}

/** The checkpoint schema remains a string; the versioned envelope survives canvas/history recovery. */
export function formatWorkflowFailure(error: unknown): string {
  const marked = markedError(error) ?? markedError(backendUsageFailure(error));
  return marked ? `${ERROR_PREFIX}${JSON.stringify(marked)}` : formatWorkflowError(error);
}

/** Decode persisted failures in status fields without treating ordinary progress text as an error. */
export function workflowStatusMessage(message: string): string {
  const parsed = record(parseResponse(message));
  return message.startsWith(ERROR_PREFIX) || (parsed && typeof parsed["kind"] === "string")
    ? workflowErrorPresentation(message).summary
    : message;
}

type Guidance = Pick<WorkflowErrorPresentation, "cause" | "action" | "steps" | "prevention">;
const GUIDANCE: Record<WorkflowErrorCode, Guidance> = {
  approval: {
    cause: "当前制作计划尚未确认，或之前的确认已经不适用于这次制作。",
    action: "打开「查看执行计划」，核对当前资料与步骤，确认后再继续。",
    steps: [
      "补齐制作资料并选择模型。",
      "查看并确认当前执行计划。",
      "按节点提示审核阶段成果，再继续制作。",
    ],
    prevention: "修改资料、模型或分镜后，重新查看并确认计划；每次确认只适用于当时的版本。",
  },
  input_changed: {
    cause: "当前资料或制作设置与已有计划、审批或成果对应的版本不一致。",
    action: "检查刚修改的资料，使用「按当前资料重新制作」或重新生成计划，再审核当前版本。",
    steps: [
      "确定本次使用的素材、要求、模型和分镜。",
      "按当前资料重新规划并确认。",
      "审核新版本成果后继续制作。",
    ],
    prevention: "续跑前保持原资料和设置；需要改动时先重新规划，避免把旧成果当作新资料的结果。",
  },
  requirements: {
    cause: "本次操作缺少完成该步骤所必需的资料或设置。",
    action: "按报错中指出的字段，以及节点下方的必填项清单，补齐缺失内容。",
    steps: [
      "填写带红色星号的内容，并添加对应专用素材。",
      "检查必填项清单已补齐。",
      "查看并确认执行计划后开始。",
    ],
    prevention: "先补齐必填项再提交；商品原图、人物参考和原曲请放在各自的专用入口。",
  },
  model_configuration: {
    cause: "当前步骤没有选到已启用且具备所需能力的项目模型。",
    action: "检查供应商连接与模型绑定，在节点内选择符合报错所需能力的模型。",
    steps: [
      "在供应商设置中启用连接与模型绑定。",
      "在节点内选择该步骤所需的文本、图片、视频或语音模型。",
      "重新查看并确认计划后继续。",
    ],
    prevention: "开始前核对模型的读图、语音、时长等能力；更换模型后重新确认计划。",
  },
  materials: {
    cause: "选中的素材不符合当前入口或模式的要求，或文件无法被正常读取。",
    action: "按报错要求重新选择可读取的非空素材；先确认当前模式及素材用途。",
    steps: [
      "确认制作模式以及需要的素材类型。",
      "在对应入口添加符合要求的原始文件。",
      "补齐资料后重新查看并确认计划。",
    ],
    prevention: "不要移动或覆盖正在使用的文件；更换素材后重新制作并审核计划。",
  },
  task_pending: {
    cause: "原任务的最终状态尚未确认，或本次等待已结束；这不能证明供应商已经停止执行。",
    action: "使用当前步骤的继续查询或恢复入口，核对原任务状态；确认失败前不要再次提交生成。",
    steps: [
      "保留当前节点与原任务记录。",
      "查询或恢复原任务，检查是否已有结果。",
      "结果可用后继续；确需重新生成时按界面明确确认。",
    ],
    prevention: "等待或查询超时后先检查原任务，避免重复提交产生额外费用。",
  },
  task_identity: {
    cause: "当前步骤的任务记录缺失、对应不唯一，或不属于当前工作流，无法安全判断是否应该重试。",
    action: "先在生成历史或工作流历史中核对原任务；找不到时重新规划并明确确认新生成。",
    steps: [
      "核对所属画布、工作流和生成历史。",
      "找到原任务后从原记录恢复。",
      "无法恢复时检查已有结果，再明确确认新的制作计划。",
    ],
    prevention: "使用原节点或原历史记录继续任务，避免把复制的节点当作原任务续跑。",
  },
  plan: {
    cause: "执行计划中的步骤、引用或先后依赖不完整，当前无法按正确顺序执行。",
    action: "重新生成当前资料对应的执行计划，核对镜头、资产引用与步骤顺序后确认。",
    steps: [
      "补齐计划需要的素材和上游成果。",
      "重新生成并检查执行计划。",
      "确认有效计划后按依赖顺序执行。",
    ],
    prevention: "修改或移除上游成果后重新规划；不要跳过需要的前置步骤。",
  },
  output_invalid: {
    cause: "这一步得到的内容缺少必要字段，或未满足工作流的结构、引用或质量要求。",
    action: "检查当前阶段的输出和修改意见，修订或重试该阶段，通过审核后再继续。",
    steps: [
      "检查当前阶段的具体不合格项。",
      "修订或重试当前阶段。",
      "审核有效成果，再进入下游制作。",
    ],
    prevention: "完成每阶段的检查后再继续；不要将缺项或未通过检查的内容直接用于生成或合成。",
  },
  storage: {
    cause: "本地文件或历史记录没有成功读取、保存或恢复；具体原因以完整报错为准。",
    action: "检查文件是否存在、保存位置是否可写及磁盘空间。修复后优先恢复原任务的保存。",
    steps: [
      "核对原文件、保存目录与历史记录。",
      "修复文件访问或保存问题。",
      "恢复保存或继续当前步骤，确认本地结果可用。",
    ],
    prevention: "制作期间保留原文件与任务记录，使用可写且空间充足的保存目录。",
  },
  runtime: {
    cause: "当前步骤依赖的本机功能组件未就绪，或版本不支持这项操作。",
    action: "打开顶部「功能组件」，按报错准备、修复或更新对应组件，完成后主动继续当前步骤。",
    steps: [
      "在「功能组件」检查所需组件与依赖。",
      "安装、导入离线包或修复组件。",
      "回到原工作流继续当前步骤。",
    ],
    prevention: "开始本机处理前检查所需组件状态；安装完成后确认继续操作。",
  },
  download: {
    cause: "原视频或所需媒体尚未成功取得为可用的本地文件。",
    action: "检查报错中的链接与访问条件；需要登录时检查下载器的登录来源，也可选择已有本地原片。",
    steps: [
      "确认链接可访问，或选择可正常播放的本地视频。",
      "通过原下载任务重试并确认文件可用。",
      "更换来源时按当前资料重新规划，再继续分析。",
    ],
    prevention: "提交前验证来源可访问；下载未确认完成时先检查原任务，避免直接进入分析。",
  },
  review: {
    cause: "当前成果尚未通过所需审核，或已有审核不再对应当前片段、分镜或音频。",
    action: "打开报错指出的当前成果，重新查看、播放或试听；确认符合要求后重新审核。",
    steps: [
      "检查当前版本的素材、分镜和片段。",
      "播放或试听实际结果，并处理不合格项。",
      "批准或选用当前成果后继续制作。",
    ],
    prevention: "修改片段、分镜、原曲或音色后重新验收，不沿用旧版本的审核结果。",
  },
  composition: {
    cause: "本机处理没有得到满足交付要求的完整结果，或缺少本次合成所需的片段。",
    action: "检查所需片段、本机组件与输出文件，修复后重试本地处理步骤。",
    steps: [
      "确认全部待使用片段已保存且经过选用。",
      "检查本机处理组件与输出目录。",
      "重试合成或渲染，并检查实际交付文件。",
    ],
    prevention: "合成前核对片段、尺寸与实际时长；在交付检查完成前保留源文件。",
  },
  unknown: {
    cause: "当前报错尚不足以确定具体原因，请结合完整报错和出错步骤核对。",
    action: "检查报错指出的项目与当前步骤；原因未确认前保留原记录，避免反复重新生成。",
    steps: [
      "核对当前素材、设置与出错步骤。",
      "查看完整报错，修复已确认的问题。",
      "已有任务先查询或恢复；输入改变时重新规划并确认。",
    ],
    prevention: "每次修改后核对当前版本与计划，遇到未确认状态时先查原任务。",
  },
};

/** Compatibility for old checkpoints and existing local validation strings only. */
function localCode(message: string): WorkflowErrorCode {
  if (/任务.*(?:身份.*(?:丢失|缺少)|没有.*(?:身份|记录))|没有可续查|缺少.*历史身份/.test(message))
    return "task_identity";
  if (/已(?:修改|改变|变化|移除)|不一致|签名.*(?:改变|不匹配)|版本.*(?:改变|失效)/.test(message))
    return "input_changed";
  if (/尚未确认|先确认|先.*(?:审核|批准)|尚未.*批准|计划.*确认|授权数量/.test(message))
    return "approval";
  if (
    /循环依赖|重复依赖|不存在的依赖|执行计划.*(?:重复|为空|无法执行|不存在)|未定义资产|引用.*不存在/.test(
      message,
    )
  )
    return "plan";
  if (/任务状态.*(?:未确认|unknown|interrupted)|等待.*超时|查询.*超时|超时.*原任务/.test(message))
    return "task_pending";
  if (/组件|引擎不可用|运行时.*(?:缺|未|不可用)|runtime.*(?:missing|unavailable)/i.test(message))
    return "runtime";
  if (
    /模型|供应商/.test(message) &&
    /请选择|请.*选择|未选择|未配置|不可用的|可用的|支持读图|支持视觉|时长配置/.test(message)
  )
    return "model_configuration";
  if (/原片下载|下载.*(?:失败|未完成|路径)|链接.*(?:无效|完整|http)|只支持.*链接/.test(message))
    return "download";
  if (
    /(?:保存|读取|恢复|打开|导出).*(?:失败|无法|未完成)|历史记录.*(?:失败|缺失)|文件.*(?:不存在|丢失|读取失败)|permission denied|no space|ENOENT|EACCES/i.test(
      message,
    )
  )
    return "storage";
  if (
    /白底|透明底|参考素材.*(?:非空|有效)|空文件|素材.*(?:格式|类型)|选择.*(?:图片|视频|歌曲|素材)|资料读取失败/.test(
      message,
    )
  )
    return "materials";
  if (/重新试听|试听|对口型|音色 ID|尚未.*(?:验收|选用|审核)|缺少.*配音片段/.test(message))
    return "review";
  if (/渲染|合成|解码|实际.*时长|本地处理.*尺寸|本地.*交付/.test(message)) return "composition";
  if (/请填写|请提供|设置缺失|配置缺失|必填|请.*添加.*原图/.test(message)) return "requirements";
  if (
    /JSON|协议|字段|输出|必须|应提供|标注无效|不能重复|ID 重复|不合格|质检|验收标准/.test(message)
  )
    return "output_invalid";
  return "unknown";
}

/** Backend kinds identify preflight/local failures even when they occur inside a remote-call method. */
function backendUsageFailure(error: unknown): Error | null {
  const payload = record(parseResponse(error));
  const details = record(payload?.["details"]);
  if (details?.["errorOrigin"] === "model") return null;
  if (details?.["errorOrigin"] === "workflow") {
    const suppliedCode = details["workflowErrorCode"];
    const code =
      typeof suppliedCode === "string" && Object.hasOwn(GUIDANCE, suppliedCode)
        ? (suppliedCode as WorkflowErrorCode)
        : localCode(localSummary(error));
    return workflowUsageError(code, localSummary(error), error);
  }
  const kind = payload?.["kind"];
  if (typeof kind !== "string") return null;
  const codes: Partial<Record<string, WorkflowErrorCode>> = {
    database: "storage",
    io: "storage",
    credential: "model_configuration",
    desktop: "runtime",
    not_found: "task_identity",
    json: "output_invalid",
    url: "model_configuration",
    conflict: "unknown",
  };
  const code =
    kind === "validation"
      ? localCode(localSummary(error))
      : Object.hasOwn(codes, kind)
        ? codes[kind]
        : undefined;
  return code ? workflowUsageError(code, localSummary(error), error) : null;
}

function legacyModelFailure(error: unknown): boolean {
  const parsed = parseResponse(error);
  const message = typeof parsed === "string" ? parsed : record(parsed)?.["message"];
  return (
    typeof message === "string" &&
    /prompt model chat completion failed|供应商请求超时/.test(message)
  );
}

function localSummary(error: unknown): string {
  const parsed = parseResponse(error);
  const payload = record(parsed);
  const value = typeof parsed === "string" ? parsed : payload?.["message"];
  const message =
    typeof value === "string"
      ? redact(value)
          .replace(/^[A-Za-z][A-Za-z/ ]*?\berror:\s*/, "")
          .trim()
      : "";
  // Never promote an opaque payload or a JavaScript stack to the user-facing sentence.
  if (
    !message ||
    message === "[object Object]" ||
    message.startsWith(ERROR_PREFIX) ||
    /^[{[]/.test(message)
  )
    return "当前工作流步骤未能完成。";
  if (!/[\u3400-\u9fff]/.test(message)) {
    const details = record(payload?.["details"]);
    if (details?.["errorOrigin"] === "workflow" && details["workflowErrorCode"] === "download") {
      const status = details["httpStatus"];
      return `参考素材下载失败${typeof status === "number" ? `（HTTP ${status}）` : ""}，当前步骤无法取得所需文件。`;
    }
    const localized: Partial<Record<string, string>> = {
      validation: "当前步骤的输入或设置不符合要求。",
      database: "工作流本地记录读取或保存失败。",
      io: "工作流所需文件读取或保存失败。",
      credential: "所需供应商凭据无法读取，请检查连接设置。",
      desktop: "当前桌面运行能力不可用。",
      not_found: "所需任务、素材或配置记录未找到。",
      json: "当前步骤的数据格式无法读取。",
      url: "供应商连接地址格式不正确。",
      conflict: "当前记录发生版本冲突，请刷新后核对。",
    };
    const kind = payload?.["kind"];
    if (typeof kind === "string" && Object.hasOwn(localized, kind)) return localized[kind]!;
    return localCode(message) === "storage"
      ? "工作流所需文件读取或保存失败。"
      : "当前工作流步骤未能完成。";
  }
  return message.split(/\n\s*at /)[0]!.slice(0, 2000);
}

export function workflowErrorPresentation(error: unknown): WorkflowErrorPresentation {
  const marked = markedError(error) ?? markedError(backendUsageFailure(error));
  if (marked?.origin === "model" || (!marked && legacyModelFailure(error))) {
    return {
      origin: "model",
      summary: "模型调用失败，完整原始报错如下。",
      cause: null,
      action: null,
      steps: [],
      prevention: null,
      details: marked?.raw ?? completeError(error),
    };
  }
  const summary = localSummary(marked?.message ?? error);
  const code = marked?.code ?? localCode(summary);
  let guidance = GUIDANCE[code];
  if (code === "runtime" && /桌面端|桌面应用/.test(summary)) {
    guidance = {
      cause: "当前工作流需要桌面应用提供的供应商连接与本机处理能力，浏览器预览无法执行。",
      action: "在桌面应用中打开这张画布，确认所需组件就绪后继续工作流。",
      steps: [
        "打开桌面应用并进入所属画布。",
        "检查供应商连接和所需功能组件。",
        "查看并确认执行计划后继续。",
      ],
      prevention: "需要下载、生成或本机处理的工作流请在桌面应用中执行。",
    };
  }
  if (code === "materials" && /白底|透明底/.test(summary)) {
    guidance = {
      ...guidance,
      cause: "原图保真合成要求白底或透明底商品图，当前原片不符合这一模式的输入要求。",
      action: "换用白底或透明底商品图；需要保留整张原片时，选择支持原片的模式，再重新确认计划。",
      prevention: "先选择制作模式，再按该模式的素材要求上传商品图。",
    };
  }
  const raw = marked?.raw ?? completeError(error);
  return { origin: "workflow", summary, ...guidance, details: raw === summary ? null : raw };
}

/** Tauri rejects with plain BackendErrorPayload objects, not JavaScript Errors. */
export function formatWorkflowError(error: unknown): string {
  const persisted = persistedError(error) ?? persistedError(record(error)?.["message"]);
  if (persisted) return persisted.message;
  const parts: string[] = [];
  const seen = new Set<object>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value === "[object Object]") return;
    const text = redact(value.trim());
    if (!parts.includes(text)) parts.push(text);
  };
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 3) return;
    if (typeof value === "string") {
      add(value);
      return;
    }
    const payload = record(value);
    if (!payload || seen.has(payload)) return;
    seen.add(payload);
    add(payload["message"]);
    add(payload["source"]);
    if (typeof payload["code"] === "string" && payload["code"].trim()) {
      add(`错误码：${payload["code"]}`);
    }
    collect(payload["error"], depth + 1);
  };

  const parsed = parseResponse(error);
  collect(parsed);
  const details = record(record(parsed)?.["details"]);
  if (details) {
    const status = details["httpStatus"];
    if (typeof status === "number" || (typeof status === "string" && /^\d{3}$/.test(status))) {
      add(`HTTP ${status}`);
    }
    collect(details);
    // Read only error fields, never request headers, stack traces or full payloads.
    const response = parseResponse(details["rawResponse"]);
    if (record(response)) collect(response);
  }

  const message =
    parts.join("\n") || "工作流执行失败，未收到可读的错误信息。请在生成历史中查看详情。";
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}
