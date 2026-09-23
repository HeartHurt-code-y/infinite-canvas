import type {
  ProductSceneRow,
  ProductSceneWorkflowCheckpoint,
  ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";

export interface ProductSceneLogoAsset {
  readonly path: string;
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly approved: boolean;
}
export interface ProductSceneQualityOptions {
  readonly inspectPorts: boolean;
  readonly portSpecification: string;
  readonly logo?: ProductSceneLogoAsset;
}
export type ProductScenePortStatus = "pass" | "fail" | "uncertain" | "not_visible";
export interface ProductSceneInspection {
  readonly version: 1;
  readonly ports: {
    readonly status: ProductScenePortStatus;
    readonly evidence: string;
    readonly items: readonly {
      readonly name: string;
      readonly expected: string;
      readonly observed: string;
      readonly status: ProductScenePortStatus;
    }[];
  };
  readonly logo: {
    readonly status: "place" | "not_visible" | "uncertain";
    readonly confidence: number;
    readonly surfaceClear: boolean;
    readonly quad: readonly { readonly x: number; readonly y: number }[] | null;
    readonly evidence: string;
  };
}
export interface ProductSceneQualityState {
  readonly status: "pending" | "passed" | "blocked" | "failed";
  readonly basePath: string;
  readonly outputPath: string | null;
  readonly inspection: ProductSceneInspection | null;
  readonly attempt: number;
  readonly error: string | null;
  readonly appliedLogoHash?: string;
}

export function productSceneQualityEnabled(options: ProductSceneWorkflowOptions): boolean {
  return options.quality?.inspectPorts === true || options.quality?.logo != null;
}
export function productSceneQualityOptionsValid(options: ProductSceneWorkflowOptions): boolean {
  const quality = options.quality;
  if (!quality) return true;
  if (typeof quality.inspectPorts !== "boolean" || typeof quality.portSpecification !== "string")
    return false;
  const logo = quality.logo;
  return (
    !logo ||
    Boolean(
      (options.generationMode ?? "composite") === "reference" &&
      logo.approved &&
      logo.path.trim() &&
      /^[a-f0-9]{64}$/i.test(logo.contentHash) &&
      Number.isInteger(logo.width) &&
      logo.width > 0 &&
      Number.isInteger(logo.height) &&
      logo.height > 0,
    )
  );
}
export function productSceneRowCanAccept(
  row: ProductSceneRow,
  options: ProductSceneWorkflowOptions,
): boolean {
  if (!productSceneQualityOptionsValid(options)) return false;
  if (
    !row.outputPath ||
    row.status === "running" ||
    row.status === "queued" ||
    row.status === "error"
  )
    return false;
  if (!productSceneQualityEnabled(options)) return true;
  const quality = row.quality;
  if (quality?.status !== "passed" || quality.outputPath !== row.outputPath || !quality.inspection)
    return false;
  try {
    const inspection = parseProductSceneInspection(JSON.stringify(quality.inspection));
    if (productSceneInspectionBlockReason(inspection, options)) return false;
    return (
      !options.quality?.logo ||
      inspection.logo.status !== "place" ||
      quality.appliedLogoHash === options.quality.logo.contentHash
    );
  } catch {
    return false;
  }
}
export function resetProductSceneQuality(
  state: ProductSceneWorkflowCheckpoint,
  rowId: string,
): ProductSceneWorkflowCheckpoint {
  return {
    ...state,
    batchReviewPending: false,
    rows: state.rows.map((row) => {
      const basePath = row.quality?.basePath ?? row.outputPath;
      if (row.id !== rowId || !basePath) return row;
      return {
        ...row,
        status: "needs_review",
        outputPath: basePath,
        error: null,
        quality: {
          status: "pending",
          basePath,
          outputPath: null,
          inspection: null,
          attempt: (row.quality?.attempt ?? -1) + 1,
          error: null,
        },
      };
    }),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是 JSON 对象。`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12000)
    throw new Error(`${name} 必须包含明确的检查证据。`);
  return value;
}
function portStatus(value: unknown): ProductScenePortStatus {
  if (value !== "pass" && value !== "fail" && value !== "uncertain" && value !== "not_visible")
    throw new Error("接口检查状态无效。");
  return value;
}
/** TL, TR, BR, BL in normalized image coordinates; convex and large enough to invert safely. */
function parseQuad(value: unknown): readonly { readonly x: number; readonly y: number }[] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error("Logo 透视区域必须有四个角点。");
  const quad = value.map((point) => {
    const item = object(point, "Logo 角点"),
      x = item["x"],
      y = item["y"];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1
    )
      throw new Error("Logo 角点必须在 0～1 图片范围内。");
    return { x, y };
  });
  let area = 0;
  for (let index = 0; index < 4; index++) {
    const a = quad[index]!,
      b = quad[(index + 1) % 4]!,
      c = quad[(index + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross <= 1e-7)
      throw new Error("Logo 四边形必须按左上、右上、右下、左下顺序构成不退化的凸区域。");
    area += a.x * b.y - b.x * a.y;
  }
  if (
    area / 2 < 1e-6 ||
    area / 2 > 0.25 ||
    quad[0]!.y + quad[1]!.y >= quad[2]!.y + quad[3]!.y ||
    quad[0]!.x + quad[3]!.x >= quad[1]!.x + quad[2]!.x
  )
    throw new Error("Logo 区域过小、超过画面四分之一或角点顺序不正确。");
  return quad;
}
export function parseProductSceneInspection(raw: string): ProductSceneInspection {
  const data = object(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    ) as unknown,
    "检测结果",
  );
  if (data["version"] !== 1) throw new Error("产品检测版本必须为 1。");
  const ports = object(data["ports"], "ports"),
    logo = object(data["logo"], "logo");
  const rawItems = ports["items"];
  if (!Array.isArray(rawItems) || rawItems.length > 100)
    throw new Error("接口检查项必须为数组且不超过 100 项。");
  const items = rawItems.map((value) => {
    const item = object(value, "接口检查项");
    return {
      name: text(item["name"], "接口名"),
      expected: text(item["expected"], "预期接口证据"),
      observed: text(item["observed"], "观察到的接口"),
      status: portStatus(item["status"]),
    };
  });
  const status = portStatus(ports["status"]);
  if (items.some((item) => item.status === "fail") && status !== "fail")
    throw new Error("接口汇总不能掩盖逐项失败。");
  if (
    !items.some((item) => item.status === "fail") &&
    items.some((item) => item.status === "uncertain") &&
    status !== "uncertain"
  )
    throw new Error("接口汇总不能掩盖逐项证据不足。");
  if (status === "pass" && (!items.length || items.some((item) => item.status !== "pass")))
    throw new Error("接口全部通过必须有逐项证据，不能掩盖失败、不可见或不确定项。");
  if (status === "not_visible" && items.some((item) => item.status !== "not_visible"))
    throw new Error("接口不可见的汇总不能掩盖已观察到的异常。");
  const logoStatus = logo["status"],
    confidence = logo["confidence"],
    surfaceClear = logo["surfaceClear"];
  if (logoStatus !== "place" && logoStatus !== "not_visible" && logoStatus !== "uncertain")
    throw new Error("Logo 检查状态无效。");
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    typeof surfaceClear !== "boolean"
  )
    throw new Error("Logo 置信度或表面状态无效。");
  const quad = logoStatus === "place" ? parseQuad(logo["quad"]) : null;
  if (logoStatus !== "place" && logo["quad"] !== null)
    throw new Error("不可见或不确定的 Logo 不得返回贴回区域。");
  return {
    version: 1,
    ports: { status, evidence: text(ports["evidence"], "接口检查证据"), items },
    logo: {
      status: logoStatus,
      confidence,
      surfaceClear,
      quad,
      evidence: text(logo["evidence"], "Logo 检查证据"),
    },
  };
}
export function productSceneInspectionBlockReason(
  inspection: ProductSceneInspection,
  options: ProductSceneWorkflowOptions,
): string | null {
  if (
    options.quality?.inspectPorts &&
    (inspection.ports.status === "fail" || inspection.ports.status === "uncertain")
  )
    return `接口检测${inspection.ports.status === "fail" ? "不通过" : "证据不足"}：${inspection.ports.evidence}`;
  if (options.quality?.logo) {
    if (inspection.logo.status === "uncertain")
      return `Logo 位置无法可靠确认：${inspection.logo.evidence}`;
    if (
      inspection.logo.status === "place" &&
      (!inspection.logo.surfaceClear || inspection.logo.confidence < 0.9)
    )
      return `Logo 区域非空白或定位置信度低于 90%，已阻止贴回：${inspection.logo.evidence}`;
  }
  return null;
}
