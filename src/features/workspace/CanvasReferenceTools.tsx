import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { backendErrorMessage, localBase64AssetClient, pickLocalMediaFiles, type LocalBase64AssetRecord } from "../../lib/backend";
import { useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import { CanvasReferencePickingContext } from "./canvasReferencePicking";
import {
  NEW_NODE_GAP,
  assetNodeKey,
  assetNodeDimensions,
  fitMediaNodeDimensions,
  genNodeDimensions,
  localAssetToItem,
  nearestAvailableNodePosition,
  outputNodeDimensions,
  type AssetItem,
  type AssetNodeData,
  type GenNodeData,
  type VideoClipNodeData,
} from "./workspaceModel";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import { CanvasReferenceUpload } from "./CanvasReferenceUpload";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasVideoEditor.css";

/**
 * 支持「参考素材」的生成节点：图片 / 视频 / 音频。
 *
   * 音频节点只接受音色参考，图片节点只接受图片；视频节点沿用多媒体参考。
 */
type MediaGenNode = Extract<GenNodeData, { kind: "image" | "video" | "audio" }>;
const IMAGE_REFERENCES = ["image"] as const;
const AUDIO_REFERENCES = ["audio"] as const;
const MEDIA_REFERENCES = ["image", "video", "audio"] as const;

export interface CanvasReferenceToolsProps {
  readonly node: MediaGenNode | VideoClipNodeData;
  /** 编辑层是否展开（收起时不做画布拾取）。 */
  readonly active: boolean;
  readonly headless?: boolean;
  readonly disabled?: boolean;
  readonly onError?: (error: string | null) => void;
}

type VideoFrameMode = "first_frame" | "first_last_frame";

export interface CanvasReferenceToolsHandle {
  /**
   * 把一批本地文件导入素材库并连到本节点。
   *
   * 角色库选好的参考图走这条：角色引用图不在本机文件系统里现成可见，
   * 但落库、入画布、连线同样是本地闭环，不需要后端。
   */
  addFiles: (paths?: readonly string[]) => Promise<boolean>;
  addVideoFrames: (mode: VideoFrameMode) => Promise<boolean>;
}

/**
 * 本地文件与库内素材共用建节点和连线逻辑，画布参考则直接连接现有节点。
 */
export const CanvasReferenceTools = forwardRef<
  CanvasReferenceToolsHandle,
  CanvasReferenceToolsProps
>(function CanvasReferenceTools({ node, active, headless = false, disabled = false, onError }, ref) {
  const commands = useCanvasCommands();
  const store = useCanvasStore();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const referencePicking = useContext(CanvasReferencePickingContext);
  const picking = referencePicking?.session?.targetKey === node.key;
  const pickButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onError?.(error); }, [error, onError]);
  useLayoutEffect(() => {
    if (picking && (!active || disabled)) referencePicking.setSession(null);
  }, [active, disabled, picking, referencePicking]);
  const audioOnly = node.kind === "audio";
  const imageOnly = node.kind === "image";

  const connectAssets = useCallback((records: readonly AssetItem[]) => {
    const state = store.getState();
    const live = state.nodesById[node.key];
    if (!live || (live.type !== "gen" && live.type !== "videoClip") || live.data.kind !== node.kind) return false;
    if (disabledRef.current) throw new Error("当前节点正在处理任务，完成后可从素材库连接。");
    const occupied = Object.values(state.nodesById).map(entry => {
      const dimensions = entry.type === "asset" ? assetNodeDimensions(entry.data)
        : entry.type === "output" ? outputNodeDimensions(entry.data)
        : entry.type === "gen" ? entry.data.measured ?? genNodeDimensions(entry.data.kind)
        : entry.data.measured ?? { width: 622, height: 400 };
      return { x: entry.data.x, y: entry.data.y, ...dimensions };
    });
    const size = fitMediaNodeDimensions();
    const assets = records.map((record): { type: "asset"; data: AssetNodeData } => {
      const position = nearestAvailableNodePosition({
        x: live.data.x - size.width - NEW_NODE_GAP,
        y: live.data.y,
        ...size,
      }, occupied);
      occupied.push({ ...position, ...size });
      return {
        type: "asset",
        data: {
          key: assetNodeKey(),
          assetId: record.id,
          providerConnectionId: record.providerConnectionId ?? "",
          source: record.source ?? "cloud",
          kind: record.kind,
          name: record.name,
          previewUrl: record.previewUrl ?? null,
          videoUrl: record.kind === "video" ? (record.videoUrl ?? record.previewUrl ?? null) : null,
          ...position,
        },
      };
    });
    const connection = commands.insertSubgraph(assets, assets.map(({ data }) => ({
      id: data.key + "->" + node.key,
      fromKey: data.key,
      toKey: node.key,
    })));
    return connection === "applied";
  }, [commands, node.key, node.kind, store]);

  const addFiles = useCallback(
    async (paths?: readonly string[], frameMode?: VideoFrameMode) => {
      if (busyRef.current || disabled) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const initialEdges = frameMode ? store.getState().assetEdges.filter(edge => edge.toKey === node.key) : [];
      try {
        let selected: readonly string[];
        if (frameMode) {
          const [first] = await pickLocalMediaFiles(["image"], { multiple: false, title: "选择首帧图片" });
          if (!first || !mountedRef.current || disabledRef.current || !store.getState().nodesById[node.key]) return false;
          selected = [first];
          if (frameMode === "first_last_frame") {
            const [last] = await pickLocalMediaFiles(["image"], { multiple: false, title: "选择尾帧图片" });
            if (!last) return false;
            selected = [first, last];
          }
        } else {
          selected = paths ?? await pickLocalMediaFiles(audioOnly ? ["audio"] : imageOnly ? ["image"] : undefined);
        }
        const frames: LocalBase64AssetRecord[] = [];
        let connected = false;
        for (const path of selected) {
          if ((frameMode && !mountedRef.current) || disabledRef.current || !store.getState().nodesById[node.key]) return false;
          const record = await localBase64AssetClient.importAsset({ localPath: path });
          if (audioOnly && record.mediaType !== "audio") {
            throw new Error("音频节点只接受音频素材作为音色参考。");
          }
          if ((imageOnly || frameMode) && record.mediaType !== "image") {
            throw new Error(frameMode ? "首帧和尾帧必须使用图片素材。" : "图片节点只接受图片作为参考素材。");
          }
          if (frameMode) {
            frames.push(record);
          } else {
            if (!connectAssets([localAssetToItem(record)])) return false;
            connected = true;
          }
        }
        // 两次选图和入库都完成后，一起建立首帧、尾帧连线，保持选择顺序。
        if (!frameMode) return connected;
        if (!frames.length || !mountedRef.current) return false;
        const state = store.getState();
        const live = state.nodesById[node.key];
        const incoming = state.assetEdges.filter(edge => edge.toKey === node.key);
        if (
          live?.type !== "gen" || live.data.kind !== "video" ||
          live.data.config.videoMode !== frameMode ||
          incoming.length !== initialEdges.length ||
          incoming.some((edge, index) => edge.id !== initialEdges[index]?.id || edge.fromKey !== initialEdges[index]?.fromKey)
        ) {
          throw new Error("节点模式或连线已变化，导入的帧图片仍可在素材库中使用。");
        }
        return connectAssets(frames.map(localAssetToItem));
      } catch (failure) {
        if (mountedRef.current) setError(backendErrorMessage(failure));
        return false;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [audioOnly, imageOnly, connectAssets, node.key, store, disabled],
  );

  useImperativeHandle(ref, () => ({
    addFiles,
    addVideoFrames: mode => addFiles(undefined, mode),
  }), [addFiles]);

  if (headless) return error && !onError ? <ErrorAlert error={error} variant="inline" hint="素材导入没有发起生成，请检查后重新上传。" /> : null;

  return (
    <>
      <CanvasReferenceUpload
        active={active}
        disabled={disabled}
        busy={busy}
        kinds={imageOnly ? IMAGE_REFERENCES : audioOnly ? AUDIO_REFERENCES : MEDIA_REFERENCES}
        icon={(node.kind === "video" || imageOnly) ? <LibTVMediaIcon name="plus-s" size={12} /> : <CanvasChromeIcon name="plus" size={12} />}
        onOpen={() => {
          if (picking) referencePicking.setSession(null);
          setError(null);
        }}
        onLocalUpload={() => { void addFiles(); }}
        onChooseAsset={asset => {
          if (!connectAssets([asset])) throw new Error("当前节点无法连接素材，请关闭素材库后重试。");
        }}
      />
      <button
        ref={pickButtonRef}
        type="button"
        className="canvas-gen-node__tool-chip canvas-reference-pick-trigger"
        aria-pressed={picking}
        data-tooltip="在当前画布中添加参考"
        disabled={disabled || !referencePicking}
        onClick={() => {
          setError(null);
          referencePicking?.setSession(picking ? null : {
            targetKey: node.key,
            onError: setError,
            addAsset: asset => connectAssets([asset]),
            restoreFocus: () => {
              const button = pickButtonRef.current;
              if (button?.getClientRects().length) button.focus({ preventScroll: true });
              else document.getElementById(`node-editor-${node.key}`)
                ?.querySelector<HTMLElement>('[data-reference-panel-trigger]')?.focus({ preventScroll: true });
            },
          });
        }}
      >
        <LibTVMediaIcon name="square-cursor" size={14} />
        <span>画布参考</span>
      </button>
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
