import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  type ComponentProps,
  type ComponentPropsWithoutRef,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "../../../components/MarkdownView";
import {
  useOptionalCanvasNodeEntry,
  useOptionalCanvasNodeMembership,
  useOptionalCanvasStore,
  type CanvasStore,
} from "../../canvas/canvasStore";
import {
  describeCanvasNodeRef,
  remarkCanvasNodeRefs,
  splitCanvasNodeKeyText,
} from "./agentNodeKeyRefs";

/**
 * 创作助手消息渲染层：在 MarkdownView 的外链安全语义之上，把消息文本里的
 * 节点代号（`gen-zwifggx4` 这类）替换成可点击定位的节点芯片。客户不需要
 * 读懂代号——芯片直接显示节点的类型与名称，点击跳到画布上的节点。
 *
 * 识别在解析期完成（remark 插件），依赖「当前画布节点集合」判定真伪；
 * 标签在渲染期按节点订阅解析，改名、删除都会实时反映。宿主没有画布上下文
 * （单测、独立预览）时全部退化为纯文本，不抛错。
 */

const AgentNodeFocusContext = createContext<((nodeKey: string) => void) | null>(null);

function CanvasNodeRefChip({ nodeKey }: { readonly nodeKey: string }) {
  const entry = useOptionalCanvasNodeEntry(nodeKey);
  const onFocus = useContext(AgentNodeFocusContext);
  // 解析失败（节点已删除、无画布上下文）时退回纯代号：没有可定位的目标，
  // 就不渲染可点击的控件，避免给客户一个点了没反应的按钮。
  if (entry == null) return <code className="canvas-node-chip-missing">{nodeKey}</code>;
  const description = describeCanvasNodeRef(entry);
  return (
    <button
      type="button"
      className="canvas-node-chip"
      title={`${description.label} · 代号 ${nodeKey}（点击在画布中定位）`}
      aria-label={`定位到画布节点：${description.label}（代号 ${nodeKey}）`}
      onClick={
        onFocus
          ? (event) => {
              event.preventDefault();
              onFocus(nodeKey);
            }
          : undefined
      }
    >
      {description.label}
    </button>
  );
}

/** react-markdown 的 button 只会来自代号节点（Markdown 本身产不出 button）。 */
function MarkdownButton({ node, ...rest }: ComponentPropsWithoutRef<"button"> & ExtraProps) {
  void node; // react-markdown 附带的 hast 节点对象，剥离后不落进 DOM 属性。
  const nodeKey = (rest as Record<string, unknown>)["data-node-key"];
  if (typeof nodeKey !== "string" || nodeKey === "") return <button {...rest} />;
  return <CanvasNodeRefChip nodeKey={nodeKey} />;
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  button: MarkdownButton,
};

/** 事件期判断 key 是否为当前画布节点；无画布上下文时永远否。 */
function useCanvasNodeKeyKnown(canvas: CanvasStore | null) {
  return useCallback(
    (key: string) => canvas?.getState().nodesById[key] != null,
    [canvas],
  );
}

function AgentMessageViewBase({
  content,
  onFocusNodeKey,
}: {
  readonly content: string;
  readonly onFocusNodeKey?: ((nodeKey: string) => void) | undefined;
}) {
  const canvas = useOptionalCanvasStore();
  const membership = useOptionalCanvasNodeMembership();
  const isKnownNodeKey = useCanvasNodeKeyKnown(canvas);
  // 自定义 remark 插件的签名与 unified 的多态 Plugin 元组对不上，这里只透传
  // 给 react-markdown 的既有管线，收敛为它的 props 类型即可。
  const remarkPlugins = useMemo<
    NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>
  >(
    () => [remarkGfm, [remarkCanvasNodeRefs, { isKnownNodeKey }]] as NonNullable<
      ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
    >,
    // 节点集合变化时强制重建插件数组：画布读取完成、撤销删节点等场景下，
    // 既有消息要按最新节点集合重新识别代号。membership 是刻意的重解析信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isKnownNodeKey, membership],
  );
  return (
    <AgentNodeFocusContext.Provider value={onFocusNodeKey ?? null}>
      <div className="markdown-view">
        <ReactMarkdown remarkPlugins={remarkPlugins} components={MARKDOWN_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </div>
    </AgentNodeFocusContext.Provider>
  );
}

/** 助手与计划消息：完整 Markdown，含节点代号芯片与外链安全语义。 */
export const AgentMessageView = memo(AgentMessageViewBase);

function AgentNodeKeyTextBase({
  text,
  onFocusNodeKey,
}: {
  readonly text: string;
  readonly onFocusNodeKey?: ((nodeKey: string) => void) | undefined;
}) {
  const canvas = useOptionalCanvasStore();
  const membership = useOptionalCanvasNodeMembership();
  const isKnownNodeKey = useCanvasNodeKeyKnown(canvas);
  const tokens = useMemo(
    () => splitCanvasNodeKeyText(text, isKnownNodeKey),
    // membership 与 remark 插件同一口径：节点集合变化后重切纯文本。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, isKnownNodeKey, membership],
  );
  return (
    <AgentNodeFocusContext.Provider value={onFocusNodeKey ?? null}>
      {tokens.map((token, index) =>
        token.kind === "text" ? (
          token.value
        ) : (
          <CanvasNodeRefChip key={index} nodeKey={token.key} />
        ),
      )}
    </AgentNodeFocusContext.Provider>
  );
}

/** 纯文本（用户消息、计划参数摘要、评审行）：同样的代号识别，无 Markdown 语法。 */
export const AgentNodeKeyText = memo(AgentNodeKeyTextBase);
