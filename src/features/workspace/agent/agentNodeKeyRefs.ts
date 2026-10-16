import type { CanvasNodeEntry } from "../../canvas/canvasStore";
import {
  CANVAS_NODE_KEY_PATTERN,
  isCanvasNodeKeyShape,
  type GenNodeData,
  type OutputNodeData,
  type VideoComposerNodeData,
} from "../workspaceModel";

/**
 * 创作助手消息里的节点代号识别：模型只能拿到 `gen-zwifggx4` 这类 key，客户看不懂。
 * 这里把文本中的节点代号切出来，交给消息层渲染成可点击定位的节点芯片。
 *
 * 识别口径是「代号形状 ∧ 当前画布存在该节点」：形状来自
 * `CANVAS_NODE_KEY_PATTERN`，存在性由调用方按当前画布节点集合注入。只看形状会把
 * `asset-photo.png`、`screenplay-draft` 这类普通词误判成代号；只看存在性则无法在
 * 文本流里定位候选。两层都过才生成芯片，其余一律保持原文——节点删除后代号退回
 * 纯文本是刻意行为：目标已经不存在，没有可定位的东西，诚实展示比假装可点更好。
 */

/** 分词结果：原样文本段，或已确认存在于当前画布的节点代号。 */
export type CanvasNodeKeyToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "nodeRef"; readonly key: string };

/** 事件期判断：该 key 是否是当前画布上的节点。 */
export type CanvasNodeKeyKnown = (key: string) => boolean;

/** 把一段纯文本切成文本段与节点代号段；没有命中当前画布的代号时原样整段返回。 */
export function splitCanvasNodeKeyText(
  text: string,
  isKnownNodeKey: CanvasNodeKeyKnown,
): readonly CanvasNodeKeyToken[] {
  const matches = [...text.matchAll(CANVAS_NODE_KEY_PATTERN)];
  if (!matches.some((match) => isKnownNodeKey(match[0]))) {
    return [{ kind: "text", value: text }];
  }
  const tokens: CanvasNodeKeyToken[] = [];
  let cursor = 0;
  for (const match of matches) {
    const key = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ kind: "text", value: text.slice(cursor, index) });
    if (isKnownNodeKey(key)) tokens.push({ kind: "nodeRef", key });
    else tokens.push({ kind: "text", value: key });
    cursor = index + key.length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens;
}

/**
 * 节点芯片的人类可读描述：类型称谓 + 用户可改的名称。名称缺失时退回
 * 「XX节点」，让无名节点（下载器、抽帧器）至少能被种类区分；完整代号放
 * 悬浮提示，客户不再需要读懂 `gen-` 前缀。
 */
export interface CanvasNodeRefDescription {
  readonly kindLabel: string;
  readonly name: string | null;
  /** 芯片可见文案：有名称时 `类型「名称」`，无名称时 `类型节点`。 */
  readonly label: string;
}

const nonEmptyText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function describeCanvasNodeRef(entry: CanvasNodeEntry): CanvasNodeRefDescription {
  let kindLabel: string;
  let name: string | null = null;
  switch (entry.type) {
    case "asset":
      kindLabel = "素材";
      name = nonEmptyText(entry.data.name);
      break;
    case "gen": {
      const data: GenNodeData = entry.data;
      kindLabel = data.kind === "video" ? "视频生成" : data.kind === "image" ? "图片生成" : "提示词";
      name = nonEmptyText(data.name);
      break;
    }
    case "screenplay":
      kindLabel = "剧本";
      break;
    case "storyboard":
      kindLabel = "分镜";
      break;
    case "knowledgeVideoWorkflow":
      kindLabel = "知识视频";
      break;
    case "viralRemix":
      kindLabel = "爆款复刻";
      break;
    case "videoComposer": {
      const data: VideoComposerNodeData = entry.data;
      kindLabel = "视频合成";
      name = nonEmptyText(data.config.outputName);
      break;
    }
    case "videoDownloader":
      kindLabel = "视频下载";
      break;
    case "frameExtractor":
      kindLabel = "视频抽帧";
      break;
    case "result":
      kindLabel = "结果";
      break;
    case "output": {
      const data: OutputNodeData = entry.data;
      kindLabel = "输出";
      name = nonEmptyText(data.customName) ?? nonEmptyText(data.name);
      break;
    }
  }
  return { kindLabel, name, label: name ? `${kindLabel}「${name}」` : `${kindLabel}节点` };
}

/* ── remark 插件：在 Markdown AST 上做同样的识别 ────────────────────────────
 * react-markdown 不支持覆盖纯文本节点，所以在 remark 树上把命中文本替换成自定义
 * 节点。mdast-util-to-hast 的 unknown handler 会尊重 data.hName/hProperties，
 * 于是自定义节点落成 <button type="button" class="canvas-node-chip"
 * data-node-key="…">，由 AgentMessageView 的 components 接管渲染。 */

/** 插件只依赖这层最小结构，不直接依赖 mdast 类型（它是 react-markdown 的传递依赖）。 */
interface RemarkTreeNode {
  readonly type: string;
  /** 代号节点带原始 key，供测试与调试检查；渲染走 data.hProperties。 */
  key?: string;
  value?: string;
  children?: RemarkTreeNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

/** 链接/图片的 URL 与锚文本不参与代号识别，避免把链接路径误切成芯片。 */
const REF_SUBTREE_SKIP_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

function nodeKeyRefNode(key: string): RemarkTreeNode {
  return {
    type: "canvasNodeRef",
    key,
    data: {
      hName: "button",
      hProperties: {
        type: "button",
        className: ["canvas-node-chip"],
        "data-node-key": key,
      },
    },
  };
}

function transformRefChildren(node: RemarkTreeNode, isKnownNodeKey: CanvasNodeKeyKnown): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  const next: RemarkTreeNode[] = [];
  let changed = false;
  for (const child of children) {
    if (REF_SUBTREE_SKIP_TYPES.has(child.type)) {
      next.push(child);
      continue;
    }
    if (child.type === "text" && typeof child.value === "string") {
      const tokens = splitCanvasNodeKeyText(child.value, isKnownNodeKey);
      if (!tokens.some((token) => token.kind === "nodeRef")) {
        next.push(child);
        continue;
      }
      changed = true;
      for (const token of tokens) {
        next.push(
          token.kind === "text"
            ? { type: "text", value: token.value }
            : nodeKeyRefNode(token.key),
        );
      }
      continue;
    }
    // 行内代码只在整段就是一个节点代号时升级为芯片；`gen-abc` 出现在更长代码里
    // （如命令行示例）时保持代码语义，避免破坏用户复制粘贴的内容。
    if (
      child.type === "inlineCode" &&
      typeof child.value === "string" &&
      isCanvasNodeKeyShape(child.value) &&
      isKnownNodeKey(child.value)
    ) {
      next.push(nodeKeyRefNode(child.value));
      changed = true;
      continue;
    }
    transformRefChildren(child, isKnownNodeKey);
    next.push(child);
  }
  if (changed) node.children = next;
}

export interface RemarkCanvasNodeRefsOptions {
  readonly isKnownNodeKey: CanvasNodeKeyKnown;
}

/** remark 插件：把消息里的节点代号替换成可点击芯片节点。 */
export function remarkCanvasNodeRefs(
  options: RemarkCanvasNodeRefsOptions,
): (tree: RemarkTreeNode) => void {
  return (tree) => {
    transformRefChildren(tree, options.isKnownNodeKey);
  };
}
