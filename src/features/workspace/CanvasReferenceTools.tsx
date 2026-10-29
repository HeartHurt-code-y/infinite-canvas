import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { backendErrorMessage, localBase64AssetClient, pickLocalMediaFiles } from "../../lib/backend";
import { canvasReadModelOfState, useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import {
  NEW_NODE_GAP,
  assetNodeKey,
  fitMediaNodeDimensions,
  outputNodeReferenceTarget,
  type AssetNodeData,
  type GenNodeData,
  type VideoClipNodeData,
} from "./workspaceModel";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import "./CanvasVideoEditor.css";

/**
 * 支持「参考素材」的生成节点：图片 / 视频 / 音频。
 *
 * 音频节点的参考语义是**音色参考**（`audio_data`），所以它只接受音频素材；
 * 图片 / 视频节点照旧接受图片与视频。
 */
type MediaGenNode = Extract<GenNodeData, { kind: "image" | "video" | "audio" }>;

export interface CanvasReferenceToolsProps {
  readonly node: MediaGenNode | VideoClipNodeData;
  /** 编辑层是否展开（收起时不做画布拾取）。 */
  readonly active: boolean;
  readonly headless?: boolean;
  readonly disabled?: boolean;
  readonly onError?: (error: string | null) => void;
}

export interface CanvasReferenceToolsHandle {
  /**
   * 把一批本地文件导入素材库并连到本节点。
   *
   * 角色库选好的参考图走这条：角色引用图不在本机文件系统里现成可见，
   * 但落库、入画布、连线同样是本地闭环，不需要后端。
   */
  addFiles: (paths?: readonly string[]) => Promise<boolean>;
}

/**
 * 生成节点的「参考素材」入口：上传本地素材 / 从画布上挑一份已存在的素材。
 *
 * 为什么图片节点与视频节点共用这一套：
 * 这条链路**根本不需要后端**——素材入库走本地素材库（localBase64AssetClient），
 * 连线走画布 store，全程前端闭环。此前只有视频节点有这套实现，图片节点的
 * 「参考」是一个死路按钮（点了只弹一句「参考素材选择后端暂未接入」），同一个
 * 编辑层里两类节点的参考能力不一致，这是不该留的不对称。
 */
export const CanvasReferenceTools = forwardRef<
  CanvasReferenceToolsHandle,
  CanvasReferenceToolsProps
>(function CanvasReferenceTools({ node, active, headless = false, disabled = false, onError }, ref) {
  const commands = useCanvasCommands();
  const store = useCanvasStore();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onError?.(error); }, [error, onError]);
  /** 音频节点只吃音频素材（音色参考）；图片 / 视频节点吃图片与视频。 */
  const audioOnly = node.kind === "audio";
  /** 画布拾取时接受的素材类别；null 表示图片与视频都收。 */
  const acceptedAssetKind = audioOnly ? "audio" : null;

  useEffect(() => {
    if (!active || !picking || disabled) return;
    const canvas = document.getElementById(`node-preview-${node.key}`)?.closest(".canvas-viewport");
    canvas?.classList.add("canvas-reference-picking");
    const pick = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const wrapper = event.target.closest<HTMLElement>(".react-flow__node[data-id]");
      const key = wrapper?.dataset["id"];
      if (!key || key === node.key) return;
      const state = store.getState();
      let entry = state.nodesById[key];
      let sourceKey = key;
      if (node.kind === "video_clip" && (entry?.type === "screenplay" || (entry?.type === "gen" && entry.data.kind === "prompt"))) {
        event.preventDefault(); event.stopPropagation();
        const result = commands.connect(sourceKey, node.key);
        setError(result.status === "rejected" ? "这份文字暂时不能连接，请检查节点。" : null);
        return;
      }
      if (
        entry?.type === "gen" &&
        (entry.data.kind === "image" || entry.data.kind === "video" || entry.data.kind === "audio")
      ) {
        const preview = canvasReadModelOfState(state).nodes.output.filter(output => output.sourceNodeId === key && (output.mediaType === "image" || output.mediaType === "video" || output.mediaType === "audio") && (output.finalPath != null || output.previewSrc != null)).at(-1);
        if (!preview || !outputNodeReferenceTarget(preview)) {
          event.preventDefault();
          event.stopPropagation();
          setError(preview ? "这份产物正在保存，请等保存完成后再选择。" : "这个节点还没有可引用的生成结果，请先生成或选择已保存的素材。");
          return;
        }
        sourceKey = preview.key;
        entry = state.nodesById[sourceKey];
      }
      if (entry?.type !== "asset" && entry?.type !== "output") return;
      if (acceptedAssetKind != null) {
        const kind =
          entry.type === "asset" ? entry.data.kind : (entry.data.mediaType as string | undefined);
        if (kind !== acceptedAssetKind) {
          event.preventDefault();
          event.stopPropagation();
          setError(
            acceptedAssetKind === "audio"
              ? "音频节点只接受音频素材作为音色参考。"
              : "这份素材的类别与当前节点不匹配。",
          );
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      const result = commands.connect(sourceKey, node.key);
      if (result.status === "rejected") setError("这份素材暂时不能连接，请等待保存完成或换一份素材。");
      else setError(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        setPicking(false);
      }
    };
    const suppressSelection = (event: MouseEvent) => {
      if (event.target instanceof Element) {
        const sourceKey = event.target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset["id"];
        if (sourceKey && sourceKey !== node.key) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    };
    document.addEventListener("pointerdown", pick, true);
    document.addEventListener("click", suppressSelection, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      canvas?.classList.remove("canvas-reference-picking");
      document.removeEventListener("pointerdown", pick, true);
      document.removeEventListener("click", suppressSelection, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [acceptedAssetKind, active, commands, node.key, node.kind, picking, store, disabled]);

  const addFiles = useCallback(
    async (paths?: readonly string[]) => {
      if (busyRef.current || disabled) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const selected = paths ?? (await pickLocalMediaFiles(audioOnly ? ["audio"] : undefined));
        let offset = 0;
        for (const path of selected) {
          const record = await localBase64AssetClient.importAsset({ localPath: path });
          if (disabledRef.current) {
            setError("素材已入库，但剪辑已开始；完成后可重新连接这份素材。");
            return false;
          }
          const live = store.getState().nodesById[node.key];
          if (
            (live?.type !== "videoClip" && (live?.type !== "gen" ||
            (live.data.kind !== "video" &&
              live.data.kind !== "image" &&
              live.data.kind !== "audio")))
          ) {
            return false;
          }
          // 音频节点只接受音频素材：图片 / 视频素材在这里没有语义，
          // 让用户以为「连上了音色」，实际提交时会被后端拒掉。
          if (audioOnly && record.mediaType !== "audio") {
            setError("音频节点只接受音频素材作为音色参考。");
            return false;
          }
          const key = assetNodeKey();
          // 素材节点不带 aspectRatio → 尺寸就是固定的素材框（与素材库里的卡片同款）。
          const size = fitMediaNodeDimensions();
          const asset: AssetNodeData = {
            key,
            assetId: record.id,
            providerConnectionId: "",
            source: "local",
            kind: record.mediaType,
            name: record.name,
            previewUrl: record.previewUrl,
            videoUrl: record.mediaType === "video" ? record.previewUrl : null,
            /*
             * 素材卡片摆在生成节点**左侧**，纵向按素材自己的高度依次排开。
             * 原来写的是固定偏移（x - 380 / y + offset * 64）：素材卡片会压住生成
             * 节点的左半边，多个素材之间还会互相重叠——生成节点宽 622，380 这个
             * 数字只是「差不多在左边」，并没有真的让开。
             */
            x: live.data.x - size.width - NEW_NODE_GAP,
            y: live.data.y + offset * (size.height + NEW_NODE_GAP),
          };
          commands.addNode("asset", asset);
          const connection = commands.connect(key, node.key);
          if (connection.status === "rejected") {
            throw new Error("素材已入库，但原节点已改变，请从画布重新连接。");
          }
          offset += 1;
        }
        return offset > 0;
      } catch (failure) {
        setError(backendErrorMessage(failure));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [audioOnly, commands, node.key, store, disabled],
  );

  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

  if (headless) return error && !onError ? <ErrorAlert error={error} variant="inline" hint="素材导入没有发起生成，请检查后重新上传。" /> : null;

  return (
    <>
      <button
        type="button"
        className="canvas-gen-node__tool-chip"
        disabled={busy || disabled}
        onClick={() => {
          void addFiles();
        }}
      >
        <CanvasChromeIcon name="plus" size={12} />
        <span>{busy ? "导入中…" : "上传"}</span>
      </button>
      <button
        type="button"
        className="canvas-gen-node__tool-chip"
        aria-pressed={picking}
        disabled={disabled}
        onClick={() => setPicking((value) => !value)}
      >
        <CanvasChromeIcon name={audioOnly ? "music" : "image"} size={12} />
        <span>画布参考</span>
      </button>
      {active && picking && !disabled
        ? createPortal(
            <div className="canvas-video-reference-bar" role="status">
              <span>从画布或资产管理选择参考</span>
              <button
                type="button"
                onClick={() => {
                  commands.selectNode(node.key);
                  setPicking(false);
                }}
              >
                返回节点
              </button>
              <button type="button" onClick={() => setPicking(false)}>
                退出
              </button>
            </div>,
            document.body,
          )
        : null}
      {error && !onError ? (
        <ErrorAlert
          error={error}
          variant="inline"
          hint="素材入库没有发起生成；检查素材和连接后重试。"
        />
      ) : null}
    </>
  );
});
