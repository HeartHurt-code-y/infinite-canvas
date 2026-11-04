/*
 * 生成页记录流（对应即梦的内容列：日期标题 → 提示词与参数标签 → 产物网格 → 操作行）。
 *
 * 实测规格：
 *   - 日期标题 24px/32px 字重 700，内边距 24px 0 0 6px；
 *   - 提示词 14px/20 白色，右侧留 8px；参数标签 14px/24、色 rgba(224,245,255,.45)，
 *     标签之间用 1px×10px 的竖线分隔（线两侧各 8px）；
 *   - 图片网格 `repeat(4,1fr)`、gap 2px、每格按 `--aspect-ratio` 撑开；
 *     视频网格 flex 换行、gap 2px、每格 `calc(50% - 2px)`、16:9；
 *   - 操作按钮高 36px、圆角 8px、底色 rgba(255,255,255,.08)、内边距 8px 14px 8px 12px、
 *     字号 12px/20；图标按钮 36×36 同底色。
 *
 * ── 抬头末位的「详细信息」与操作行末位的「…」 ────────────────────────
 * 即梦这两处都是**可点的**（2026-10-22 活体实测 + CSS 分包 `AIGeneratedRecord-*`）：
 *   - 「详细信息」是 popover 触发器（类名 `more-info-label-fe_6mm` +
 *     `more-info-mask-Bz8O4q`，文字 14/22、色 rgba(255,255,255,.6)），
 *     点开是这条记录的完整参数清单；
 *   - 「…」是记录菜单。**实测条目只有两项：删除 / 反馈生成问题**
 *     （`.dropdown-item-view-P5ukQS`，高 36px、内边距 9px 12px、圆角 8px、
 *      文字 13px/24；浮层 `.lv-popover-content` 底色 #262626、圆角 12px、
 *      0.5px 描边 rgba(204,221,255,.08)、投影 rgba(0,0,0,.24) 0 8px 56px、
 *      内容内边距 4px）。
 *     早前这里写的「取消置顶 / 重命名 / 图片 / 视频」是照旧文档猜的，
 *     即梦根本没有这四项，已按「对齐取子集」删掉；重命名能力迁到产物预览层。
 *
 * ── 视频产物卡的 hover 层 ──────────────────────────────────────────────
 * 即梦视频记录卡 hover 后浮出两层（活体实测 2026-10-22）：
 *   - 右上工具组（`.button-group-top-edBHUW`，right 8 / top 8）：
 *     下载 / 查看更多 / 收藏；
 *   - 底部工具组（`.button-group-bottom-PCvgPa`，right 8 / bottom 8）：
 *     局部重拍 / 用作参考视频 / 智能超清 / 视频延长 / 视频编辑 / 补帧 /
 *     对口型 / 全能配音 / 擦除字幕；
 *   - 底部播放条（`.controls-wXY0PO`，48px 高）：暂停/播放按钮 +
 *     `00:00 │ 00:05` 时间 + 全屏按钮，最底下是 2px 进度条。
 * 两组工具共用一块面板底：底色 rgba(24,25,29,.9)、0.5px 描边 rgba(204,221,255,.08)、
 * 圆角 8px、内边距 2px、按钮间隙 2px；按钮 28×28、图标 16×16。
 *
 * 两块浮层都 portal 到 document.body 并按视口定位，定位规则统一走
 * `useCreateFloatingLayerAnchor`（创作台口径：浮层相对触发器左移 16px、
 * 面板底边贴触发器顶边、用**实测高度**而不是高度上限定位）。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon } from "../../components/Icon";
import { useEscapeHandler } from "../../components/escapeArbiter";

import { generationClient, renameGenerationResult } from "../../lib/backend";
import { copyTextToClipboard } from "../../lib/clipboard";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { toast } from "../../lib/toast";
import {
  CREATE_COPY,
  groupDayLabel,
  isModerationFailure,
  placeholderCount,
  resolveRecordVariant,
} from "./createModel";
import type { CreateRecordFilter } from "./createPageModel";
import { CreateDetailView } from "./CreateDetailView";
import { RecordProductMenu } from "./CreateProductMenu";
import { productMenuEntries, type RecordMenuEntry } from "./createProductMenuModel";
import { JimengIcon, type JimengIconName } from "./JimengIcon";
import { useCreateFloatingLayerAnchor, useDismissOnOutside } from "./useFloatingLayerAnchor";
import type { CreateRecord, CreateResultItem } from "./useCreateSession";
import "./CreateRecordList.css";

export interface CreateRecordListProps {
  readonly records: readonly CreateRecord[];
  /** 渲染用的时间基准。 */
  readonly now: number;
  readonly filter: CreateRecordFilter;
  readonly search: string;
  readonly onRegenerate: (record: CreateRecord) => void;
  readonly onEdit: (record: CreateRecord) => void;
  /**
   * 把某个产物作为参考素材送进浮坞（即梦视频卡底部的「用作参考视频」）。
   *
   * 只有**本机已落盘**的产物才能进参考素材——后端只认三种素材身份
   * （本机文件 / 云端素材 / 本机 Base64 素材），远端签名 URL 不是其中之一。
   */
  readonly onUseAsReference?: ((result: CreateResultItem) => void) | undefined;
  /**
   * 用这张图直接发起视频生成（即梦图片格工具菜单里的「生成视频」）。
   *
   * 本项目能做是因为创作台本来就支持「带参考素材的参考生视频」：
   * 把图片作为参考素材送进浮坞 + 切到视频生成档。
   */
  readonly onGenerateVideo?: ((result: CreateResultItem) => void) | undefined;
  /**
   * 「使用提示词」：把记录里的提示词填进浮坞输入框。
   *
   * 即梦在长提示词的展开层右下角放了这枚按钮（点它即梦会把提示词填进输入框）。
   */
  readonly onUsePrompt?: ((prompt: string) => void) | undefined;
  /**
   * 取消在途生成。
   *
   * 取消只停**本机**的轮询与产物落盘：供应商侧没有取消接口，那边的任务可能
   * 继续运行并计费（文案里必须写明）。
   */
  readonly onCancel?: ((record: CreateRecord) => void) | undefined;
}

/** 产物可显示的地址：本地落盘优先，否则回退到供应商返回的远端地址。 */
function mediaSrc(result: CreateResultItem): string | null {
  if (result.finalPath) return convertFileSrc(result.finalPath);
  if (result.remoteUrl) return toMediaProxyUrl(result.remoteUrl);
  return null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "errmsg", "detail", "details"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

/** 一条记录里有没有这个媒体类型。 */
function hasMediaType(record: CreateRecord, mediaType: string): boolean {
  return record.results.some((result) => result.mediaType === mediaType);
}

/**
 * 记录流里的媒体类型。
 *
 * 视频记录用 16:9 宽幅、图片记录用 1:1 方阵，两种网格不混排：
 * 混排会让一屏里出现两种宽高比，用户很难判断哪张是同一次生成的产物。
 */
function recordGridKind(record: CreateRecord): "image" | "video" {
  return hasMediaType(record, "video") ? "video" : "image";
}

/* ── 详细信息浮层 ───────────────────────────────────────────────────── */

/** 详细信息浮层里的一行参数。 */
interface RecordParameterRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * 参数键 → 中文标签。
 *
 * 键名取自模型声明的参数能力表（即梦的记录详情浮层也是按参数名逐条列出的）。
 * 只认常见的几项，其余原样显示键名——猜错的标签比原始键名更容易误导。
 */
const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  ratio: "比例",
  aspect_ratio: "比例",
  resolution: "分辨率",
  quality: "质量",
  size: "尺寸",
  duration: "时长",
  n: "生成数量",
  seed: "随机种子",
  guidance_scale: "提示词相关度",
  negative_prompt: "反向提示词",
  task_type: "任务类型",
  action: "动作模式",
  watermark: "水印",
};

/** 生成操作 → 中文标签。 */
const OPERATION_LABELS: Readonly<Record<string, string>> = {
  text_to_image: "文生图",
  image_to_image: "图生图",
  video_generation: "视频生成",
  text_generation: "文本生成",
  speech_generation: "音频生成",
};

/** 参数值 → 展示文本；空值返回 null（这一行就不显示）。 */
function parameterValueText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => parameterValueText(item))
      .filter((item): item is string => item !== null);
    return parts.length === 0 ? null : parts.join("、");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

/**
 * 从任务详情里取出这次提交用的全部参数。
 *
 * 记录抬头上的标签只有比例与分辨率两项（见 createModel.describeRecordParameters），
 * 完整参数集只存在于任务详情的 `logicalRequest.parameters`——那是提交当时的快照，
 * 换模型改参数都不会改写它。
 */
function detailParameters(detail: {
  readonly logicalRequest?: unknown;
}): readonly RecordParameterRow[] {
  const request = detail.logicalRequest;
  if (!request || typeof request !== "object") return [];
  const parameters = (request as Record<string, unknown>)["parameters"];
  if (!parameters || typeof parameters !== "object") return [];
  const rows: RecordParameterRow[] = [];
  for (const [key, raw] of Object.entries(parameters as Record<string, unknown>)) {
    const value = parameterValueText(raw);
    if (value === null) continue;
    rows.push({ key, label: PARAMETER_LABELS[key] ?? key, value });
  }
  return rows;
}

/** 时间戳 → 本地时间文本。 */
function formatTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 「详细信息」：点开是这条记录的完整参数清单。
 *
 * 为什么要单独拉一次任务详情：抬头上的标签只有比例与分辨率两项，完整参数集在
 * 任务详情里。拉不到时（后端不可达）退回抬头上的标签并说明是降级展示，
 * 不假装拿到了完整参数。
 */
function RecordDetail({ record }: { readonly record: CreateRecord }) {
  const [open, setOpen] = useState(false);
  /** null 表示还没拿到（正在读或读失败）。 */
  const [rows, setRows] = useState<readonly RecordParameterRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { ref: popoverRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: triggerRef,
    minWidth: 280,
    maxHeight: 320,
    /* 即梦的浮层是 `lv-trigger-position-bl`：面板底边贴触发器顶边，默认朝上。 */
    preferAbove: true,
  });

  /* 只关状态，不碰 ref：焦点归还在事件回调里做（见下面的 Esc 处理）。 */
  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  useDismissOnOutside(open, popoverRef, triggerRef, close, layerId);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const detail = await generationClient.get(record.taskId);
        if (!cancelled) {
          setRows(detailParameters(detail));
          setFailed(false);
        }
      } catch {
        /* 拉不到任务详情就退回抬头上的标签，并说明是降级展示。 */
        if (!cancelled) {
          setRows(null);
          setFailed(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, record.taskId]);

  /*
   * Esc 关闭（冒泡阶段：输入框里的 Esc 由输入框自己处理）。
   * 焦点在这里还给触发按钮——写在事件回调里而不是 close() 里：
   * 渲染期读 ref.current 会被 react-hooks/refs 规则判为「可能在渲染期读 ref」。
   */
  /* Esc 关闭详情浮层：交给全应用唯一的仲裁器（`escapeArbiter`）。 */
  useEscapeHandler(
    {
      canHandle: () => open,
      handle: () => {
        close();
        triggerRef.current?.focus();
      },
    },
    open,
  );

  useEffect(() => {
    if (open) popoverRef.current?.focus();
  }, [open, popoverRef]);

  const openDetail = (): void => {
    setRows(null);
    setFailed(false);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="create-record__label create-record__label--detail"
        aria-label="详细信息"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openDetail())}
      >
        <Icon name="identification-badge" size="2xs" aria-hidden="true" />
        详细信息
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="详细信息"
              tabIndex={-1}
              className="create-record-detail"
            >
              <div className="create-record-detail__title">详细信息</div>
              <p className="create-record-detail__prompt">{record.prompt}</p>
              <dl className="create-record-detail__rows">
                <div className="create-record-detail__row">
                  <dt>模型</dt>
                  <dd>{record.modelName}</dd>
                </div>
                <div className="create-record-detail__row">
                  <dt>任务类型</dt>
                  <dd>{OPERATION_LABELS[record.operation] ?? record.operation}</dd>
                </div>
                {rows === null ? (
                  <div className="create-record-detail__row">
                    <dt>参数</dt>
                    <dd>{failed ? "读取失败" : "读取中…"}</dd>
                  </div>
                ) : (
                  rows.map((row) => (
                    <div key={row.key} className="create-record-detail__row">
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))
                )}
                <div className="create-record-detail__row">
                  <dt>产物</dt>
                  <dd>
                    {record.textOutput != null
                      ? `文本正文 ${record.textOutput.length} 字`
                      : `${record.results.length} 个`}
                  </dd>
                </div>
                <div className="create-record-detail__row">
                  <dt>创建时间</dt>
                  <dd>{formatTime(record.createdAt)}</dd>
                </div>
                <div className="create-record-detail__row">
                  <dt>任务 ID</dt>
                  <dd>{record.taskId}</dd>
                </div>
              </dl>
              {failed ? (
                <p className="create-record-detail__hint">
                  完整参数读取失败，这里只显示记录自带的信息。
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ── 记录菜单 ───────────────────────────────────────────────────────── */

/** 记录菜单里的一项。 */
interface RecordMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  /** 点不动时的原因；写出来是为了让用户知道为什么。 */
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * 操作行末位的「…」：即梦的记录菜单。
 *
 * 活体实测（2026-10-22，创作台视频记录卡右上角「查看更多」）：**只有两项**——
 * 删除 / 反馈生成问题。菜单项 36px 高、内边距 9px 12px、圆角 8px，
 * 左侧一枚 1em 图标，文字 13px/24。
 *
 * 早前这里写的「取消置顶 / 重命名 / 图片 / 视频」是照旧文档猜的，即梦并没有
 * 这几项，按「对齐取子集」删掉：能力不丢，但入口改到即梦有的地方——
 * 重命名挪到产物预览层（即梦的详情浮层右上角同样有一组操作按钮）。
 */
function RecordMenu({
  record,
  onDelete,
}: {
  readonly record: CreateRecord;
  readonly onDelete: (record: CreateRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { ref: menuRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: triggerRef,
    minWidth: 176,
    maxHeight: 320,
    preferAbove: true,
  });

  /* 只关状态，不碰 ref：焦点归还在事件回调里做（见下面的 Esc 处理）。 */
  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  useDismissOnOutside(open, menuRef, triggerRef, close, layerId);

  /* Esc 关闭操作菜单：交给全应用唯一的仲裁器（`escapeArbiter`）。 */
  useEscapeHandler(
    {
      canHandle: () => open,
      handle: () => {
        close();
        triggerRef.current?.focus();
      },
    },
    open,
  );

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [menuRef, open]);

  /*
   * 菜单条目只放**数据**，动作统一由 `select` 分派。
   * 之前把动作写成条目里的闭包，渲染期把这个数组传进 map 时，
   * react-hooks/refs 规则会判定「可能在渲染期读 ref」而报错。
   */
  const items: readonly RecordMenuItem[] = [
    { id: "delete", label: "删除", icon: "assetTrash" },
    {
      id: "feedback",
      label: "反馈生成问题",
      icon: "recordFeedback",
      disabled: true,
      hint: "后端暂未接入",
    },
  ];

  /** 菜单项被点中后的动作。 */
  const select = useCallback(
    (id: string): void => {
      if (id === "delete") {
        close();
        onDelete(record);
      }
    },
    [close, onDelete, record],
  );

  return (
    <>
      <button
        type="button"
        className="create-record__action create-record__action--icon"
        aria-label="更多操作"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {/* 即梦的「查看更多」是**横向**三点（M7 12a2 2 …），不是竖排。 */}
        <JimengIcon name="recordMore" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="dialog"
              aria-label="更多操作"
              tabIndex={-1}
              className="create-record-menu"
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="create-record-menu__item"
                  disabled={item.disabled === true}
                  title={item.hint}
                  onClick={() => select(item.id)}
                >
                  <JimengIcon name={item.icon} />
                  <span className="create-record-menu__item-label">{item.label}</span>
                  {item.hint ? (
                    <span className="create-record-menu__item-hint">{item.hint}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** 把秒数格式成 `mm:ss`（即梦的时长写法：00:05；超过一小时补小时位）。 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * 即梦视频记录卡 hover 后浮出的**底部工具组**。
 *
 * 活体实测（2026-10-22）：9 枚 28×28 按钮、16px 图标、间隙 2px，
 * 顺序是 局部重拍 / 用作参考视频 / 智能超清 / 视频延长 / 视频编辑 / 补帧 /
 * 对口型 / 全能配音 / 擦除字幕。
 *
 * 这些能力在即梦都走后端。本项目只有「用作参考视频」能真做（产物已落盘时
 * 把它作为参考素材送进浮坞），其余按项目约定保留入口并标出「后端暂未接入」，
 * 做成禁用项而不是点了没反应的按钮。
 */
const RECORD_VIDEO_TOOLS: readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  /** 提示语；写出来是为了让用户知道为什么点不动。 */
  readonly hint: string;
  /** 只有这一项在本项目里是真的可用的。 */
  readonly usable: boolean;
}[] = [
  { id: "retake", label: "局部重拍", icon: "toolRetake", hint: "后端暂未接入", usable: false },
  {
    id: "as-reference",
    label: "用作参考视频",
    icon: "toolAsReference",
    hint: "产物还没落到本机，暂时不能作为参考素材",
    usable: true,
  },
  {
    id: "super-resolution",
    label: "智能超清",
    icon: "toolSuperResolution",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "extend", label: "视频延长", icon: "toolExtendVideo", hint: "后端暂未接入", usable: false },
  {
    id: "video-edit",
    label: "视频编辑",
    icon: "toolVideoEdit",
    hint: "后端暂未接入",
    usable: false,
  },
  {
    id: "interpolate",
    label: "补帧",
    icon: "toolInterpolate",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "lip-sync", label: "对口型", icon: "toolLipSync", hint: "后端暂未接入", usable: false },
  { id: "dubbing", label: "全能配音", icon: "toolDubbing", hint: "后端暂未接入", usable: false },
  {
    id: "remove-subtitle",
    label: "擦除字幕",
    icon: "toolRemoveSubtitle",
    hint: "后端暂未接入",
    usable: false,
  },
];

/**
 * 记录卡右上角的工具组（即梦 `.button-group-top-edBHUW`）。
 *
 * 实测：下载 / 查看更多 / 收藏，三枚 28×28 按钮，共用一块面板底
 * （底色 rgba(24,25,29,.9)、0.5px 描边 rgba(204,221,255,.08)、圆角 8px、
 * 内边距 2px、按钮间隙 2px）。整组默认不显形，hover 格子才出现。
 *
 * 这一组挂在**整块媒体**上（`RecordMedia` 里渲染），不是每个格子一份——
 * 即梦的记录卡就是一组，不是每张图一组。
 */

/**
 * 视频格子的播放层（即梦 `.controls-wXY0PO`）。
 *
 * 实测（2026-10-22）：48px 高的条贴在格子底部，
 *   · 左侧：暂停/播放按钮（命中区 32×32、图标 16×16）+
 *     `00:00 │ 00:05`（Montserrat 500 13px/22px，当前时间白色、
 *     总时长 rgba(255,255,255,.55)，中间一道 0.5px 竖线）；
 *   · 右侧：全屏按钮（命中区 32×32、图标 16×16）；
 *   · 最底下：2px 进度条（轨道 rgba(255,255,255,.2)、已播白色）。
 * 整层默认不显形，hover 格子才淡入（opacity .1s linear .1s）。
 */
function RecordVideoPlayer({
  playing,
  currentTime,
  duration,
  onToggle,
  onSeek,
  onFullscreen,
}: {
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly onToggle: () => void;
  readonly onSeek: (ratio: number) => void;
  readonly onFullscreen: () => void;
}) {
  const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return (
    <div className="create-record__player">
      <div className="create-record__player-bar">
        <div className="create-record__player-left">
          <button
            type="button"
            className="create-record__player-button"
            aria-label={playing ? "暂停" : "播放"}
            onClick={onToggle}
          >
            <JimengIcon name={playing ? "playerPause" : "playerPlay"} />
          </button>
          <div className="create-record__player-time">
            <span className="create-record__player-current">{formatDuration(currentTime)}</span>
            <span className="create-record__player-divider" aria-hidden="true" />
            <span className="create-record__player-duration">{formatDuration(duration)}</span>
          </div>
        </div>
        <div className="create-record__player-right">
          <button
            type="button"
            className="create-record__player-button"
            aria-label="全屏"
            onClick={onFullscreen}
          >
            <JimengIcon name="playerFullscreen" />
          </button>
        </div>
      </div>
      <div
        className="create-record__player-timeline"
        role="slider"
        aria-label="调整视频播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width <= 0) return;
          onSeek((event.clientX - box.left) / box.width);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") onSeek(Math.min(1, ratio + 0.05));
          if (event.key === "ArrowLeft") onSeek(Math.max(0, ratio - 0.05));
        }}
      >
        <div className="create-record__player-track">
          <div className="create-record__player-progress" style={{ width: `${ratio * 100}%` }} />
          <div className="create-record__player-handler" style={{ left: `${ratio * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

/**
 * 即梦**图片**记录卡 hover 后浮出的底部工具组。
 *
 * 活体实测（2026-10-22）：7 枚，顺序是
 * 再次生成 / 用作参考图 / 智能超清 / 超清 / 智能改图 / 局部重绘 / 查看更多。
 * （视频卡那组是另外 9 枚，两者不通用。）
 *
 * 「再次生成」「用作参考图」「查看更多」在本项目里是真的能做的，
 * 其余四项没有后端能力，按约定保留入口并标出「后端暂未接入」。
 */
const RECORD_IMAGE_TOOLS: readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  readonly hint: string;
  /** 只有这一项在本项目里是真的可用的。 */
  readonly usable: boolean;
}[] = [
  {
    id: "as-reference",
    label: "用作参考图",
    icon: "toolAsReferenceImage",
    hint: "产物还没落到本机，暂时不能作为参考素材",
    usable: true,
  },
  {
    id: "super-resolution",
    label: "智能超清",
    icon: "toolSuperResolution",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "ultra-clear", label: "超清", icon: "toolUltraClear", hint: "后端暂未接入", usable: false },
  {
    id: "smart-edit",
    label: "智能改图",
    icon: "toolSmartEdit",
    hint: "后端暂未接入",
    usable: false,
  },
  {
    id: "local-redraw",
    label: "局部重绘",
    icon: "toolLocalRedraw",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "outpaint", label: "扩图", icon: "toolOutpaint", hint: "后端暂未接入", usable: false },
  { id: "more", label: "查看更多", icon: "recordMore", hint: "", usable: false },
];

/**
 * 图片格末位「查看更多」打开的**二级工具菜单**（即梦活体实测 2026-10-22）。
 *
 * 六项：生成视频 / 去画布编辑 / 消除笔 / 多角度（带 New 角标）/ 细节修复 / 对口型。
 * 这些都是即梦后端的能力；本项目只有「生成视频」能做（图生视频：切到视频档
 * 并把这张图作为参考素材），其余按约定保留入口并标「后端暂未接入」。
 */
const RECORD_TOOL_MENU: readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  readonly hint: string;
  /** 即梦给「新功能」打的那枚 New 角标。 */
  readonly isNew?: boolean;
  /** 本项目能不能真做。 */
  readonly usable: boolean;
}[] = [
  {
    id: "generate-video",
    label: "生成视频",
    icon: "toolGenerateVideo",
    hint: "后端暂未接入",
    usable: true,
  },
  {
    id: "canvas-edit",
    label: "去画布编辑",
    icon: "toolCanvasEdit",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "eraser", label: "消除笔", icon: "toolEraser", hint: "后端暂未接入", usable: false },
  {
    id: "multi-angle",
    label: "多角度",
    icon: "toolMultiAngle",
    hint: "后端暂未接入",
    isNew: true,
    usable: false,
  },
  {
    id: "detail-fix",
    label: "细节修复",
    icon: "toolDetailFix",
    hint: "后端暂未接入",
    usable: false,
  },
  { id: "lip-sync", label: "对口型", icon: "toolLipSync", hint: "后端暂未接入", usable: false },
];

function RecordCellToolGroups({
  kind,
  result,
  onUseAsReference,
  onGenerateVideo,
}: {
  readonly kind: "image" | "video";
  readonly result: CreateResultItem;
  readonly onUseAsReference?: ((result: CreateResultItem) => void) | undefined;
  readonly onGenerateVideo?: ((result: CreateResultItem) => void) | undefined;
}) {
  const isVideo = kind === "video";
  const topTriggerRef = useRef<HTMLButtonElement>(null);
  const bottomTriggerRef = useRef<HTMLButtonElement>(null);
  const [productOpen, setProductOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const closeProduct = useCallback((): void => setProductOpen(false), []);
  const closeTool = useCallback((): void => setToolOpen(false), []);

  /* 产物已落到本机才能当参考素材送进浮坞。 */
  const local = result.finalPath !== null && result.finalPath !== "";

  const productItems: readonly RecordMenuEntry[] = productMenuEntries(
    isVideo ? "video" : "image",
    local,
    onUseAsReference === undefined
      ? undefined
      : () => {
          closeProduct();
          onUseAsReference?.(result);
        },
  );

  const toolItems: readonly RecordMenuEntry[] = RECORD_TOOL_MENU.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    hint: item.hint,
    disabled: !item.usable || (item.id === "generate-video" && onGenerateVideo === undefined),
    dividerBefore: false,
    isNew: item.isNew === true,
    onSelect: () => {
      closeTool();
      if (item.id === "generate-video" && onGenerateVideo !== undefined) {
        onGenerateVideo(result);
        return;
      }
      toast(item.hint);
    },
  }));

  return (
    <>
      <div className="create-record__cell-tools">
        <button
          type="button"
          className="create-record__cell-tool"
          aria-label="下载"
          title="下载后端暂未接入"
          onClick={() => toast("下载后端暂未接入。")}
        >
          <JimengIcon name="recordDownload" />
        </button>
        <button
          ref={topTriggerRef}
          type="button"
          className="create-record__cell-tool"
          aria-label="查看更多"
          aria-haspopup="dialog"
          aria-expanded={productOpen}
          onClick={() => (productOpen ? closeProduct() : setProductOpen(true))}
        >
          <JimengIcon name="recordMore" />
        </button>
        <button
          type="button"
          className="create-record__cell-tool"
          aria-label="收藏"
          title="收藏后端暂未接入"
          onClick={() => toast("收藏后端暂未接入。")}
        >
          <JimengIcon name="recordFavorite" />
        </button>
      </div>
      {productOpen ? (
        <RecordProductMenu
          open
          anchorRef={topTriggerRef}
          items={productItems}
          onClose={closeProduct}
        />
      ) : null}

      <div className="create-record__cell-video-tools">
        {isVideo
          ? RECORD_VIDEO_TOOLS.map((tool) => {
              const enabled = tool.usable && local && onUseAsReference !== undefined;
              return (
                <button
                  key={tool.id}
                  type="button"
                  className="create-record__cell-tool"
                  disabled={!enabled}
                  title={enabled ? undefined : tool.hint}
                  aria-label={tool.label}
                  onClick={() => {
                    if (!enabled || onUseAsReference === undefined) return;
                    onUseAsReference(result);
                  }}
                >
                  <JimengIcon name={tool.icon} />
                </button>
              );
            })
          : RECORD_IMAGE_TOOLS.map((tool) => {
              if (tool.id === "more") {
                return (
                  <button
                    key={tool.id}
                    ref={bottomTriggerRef}
                    type="button"
                    className="create-record__cell-tool"
                    aria-label={tool.label}
                    aria-haspopup="dialog"
                    aria-expanded={toolOpen}
                    onClick={() => (toolOpen ? closeTool() : setToolOpen(true))}
                  >
                    <JimengIcon name={tool.icon} />
                  </button>
                );
              }
              const enabled = tool.usable && local && onUseAsReference !== undefined;
              return (
                <button
                  key={tool.id}
                  type="button"
                  className="create-record__cell-tool"
                  disabled={!enabled}
                  title={enabled ? undefined : tool.hint}
                  aria-label={tool.label}
                  onClick={() => {
                    if (!enabled || onUseAsReference === undefined) return;
                    onUseAsReference(result);
                  }}
                >
                  <JimengIcon name={tool.icon} />
                </button>
              );
            })}
      </div>
      {toolOpen ? (
        <RecordProductMenu
          open
          anchorRef={bottomTriggerRef}
          items={toolItems}
          onClose={closeTool}
        />
      ) : null}
    </>
  );
}

function RecordMedia({
  record,
  onPreview,
  onUseAsReference,
  onGenerateVideo,
}: {
  readonly record: CreateRecord;
  /**
   * 打开产物详情。
   *
   * 第二个参数是**触发元素**：详情整页视图关闭时要把焦点还给这张图，
   * 焦点不能掉回 `document.body`。
   */
  readonly onPreview: (index: number, trigger: HTMLElement) => void;
  readonly onUseAsReference?: ((result: CreateResultItem) => void) | undefined;
  readonly onGenerateVideo?: ((result: CreateResultItem) => void) | undefined;
}) {
  const kind = recordGridKind(record);
  /*
   * 产物的实际尺寸与时长。
   *
   * 即梦的单图横图会**跨 2 列**（`grid-column: span 2`，并把格子比例换成图片自己的
   * 比例）。尺寸与时长都从媒体元素自己读（图片的 naturalWidth/Height、视频的
   * videoWidth/Height 与 duration），不依赖后端多给字段。
   */
  const [sizes, setSizes] = useState<
    Readonly<Record<string, { w: number; h: number; seconds: number | null }>>
  >({});
  return (
    <div className="create-record__media" data-kind={kind}>
      {record.results.map((result, position) => {
        const src = mediaSrc(result);
        const key = `${result.taskId}-${result.resultIndex}`;
        if (!src) {
          return (
            <div
              key={key}
              className="create-record__cell create-record__cell--empty"
              aria-hidden="true"
            />
          );
        }
        if (result.mediaType === "video") {
          return (
            <VideoCell
              key={key}
              src={src}
              position={position}
              onPreview={onPreview}
              tools={
                <RecordCellToolGroups
                  kind="video"
                  result={result}
                  onUseAsReference={onUseAsReference}
                  onGenerateVideo={onGenerateVideo}
                />
              }
            />
          );
        }
        const size = sizes[key];
        const only = record.results.length === 1 ? size : undefined;
        const wide = only !== undefined && only.seconds === null && only.w > only.h;
        return (
          <div
            key={key}
            className="create-record__cell create-record__cell--image"
            style={
              wide === true && only !== undefined
                ? { gridColumn: "span 2", aspectRatio: `${only.w} / ${only.h}` }
                : undefined
            }
          >
            <img
              src={src}
              alt=""
              loading="lazy"
              /*
               * 这一格是可点的（点开产物详情），所以要能被键盘走到：
               * 之前它只是个 `<img>`，鼠标能点、键盘完全够不着。
               * `role="button"` + Enter/Space 是按钮的标准键盘语义。
               */
              role="button"
              tabIndex={0}
              aria-label={`查看第 ${position + 1} 个产物`}
              onClick={(event) => onPreview(position, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onPreview(position, event.currentTarget);
              }}
              onLoad={(event) => {
                const el = event.currentTarget;
                setSizes((previous) =>
                  previous[key] === undefined
                    ? {
                        ...previous,
                        [key]: { w: el.naturalWidth, h: el.naturalHeight, seconds: null },
                      }
                    : previous,
                );
              }}
            />
            <RecordCellToolGroups
              kind="image"
              result={result}
              onUseAsReference={onUseAsReference}
              onGenerateVideo={onGenerateVideo}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * 视频产物格。
 *
 * 即梦这一格 hover 后浮出三层（活体实测 2026-10-22）：
 *   · 右上工具组：下载 / 查看更多 / 收藏；
 *   · 底部播放条：播放/暂停 + `00:00 │ 00:05` + 全屏，最底下 2px 进度条；
 *   · 底部编辑工具组：局部重拍 / 用作参考视频 / 智能超清 / 视频延长 /
 *     视频编辑 / 补帧 / 对口型 / 全能配音 / 擦除字幕。
 *
 * 即梦的时长不另起角标，而是显示在播放条里，所以这里也不加角标。
 *
 * 播放行为也照抄即梦（活体实测：hover 前 `paused=true`，hover 后 `paused=false`
 * 且 `loop=true`）：**hover 即自动播放、移开即暂停并复位到 0**。
 * 播放先试有声，浏览器策略拒绝（未静音自动播放被拦截）再退回静音重试——
 * 即梦的播放器也是这个顺序（先 `muted=false` 试，失败才 `muted=true`）。
 */
function VideoCell({
  src,
  position,
  onPreview,
  tools,
}: {
  readonly src: string;
  /** 这条记录里的第几个产物（详情视图的翻页用）。 */
  readonly position: number;
  /** 打开产物详情；第二个参数是触发元素（关闭后焦点要还回去）。 */
  readonly onPreview: (index: number, trigger: HTMLElement) => void;
  /** 这一格的两组工具（与图片格同源，按媒体类型换条目）。 */
  readonly tools: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seek = useCallback((ratio: number): void => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(1, Math.max(0, ratio)) * video.duration;
  }, []);

  const fullscreen = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    const holder = video.closest(".create-record__cell");
    const target = holder instanceof HTMLElement ? holder : video;
    void target.requestFullscreen?.().catch(() => undefined);
  }, []);

  /** hover 即自动播放（先有声，被浏览器策略拦了就退回静音）。 */
  const startPlayback = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    void video.play().catch(() => {
      video.muted = true;
      void video.play().catch(() => undefined);
    });
  }, []);

  /** 移开即暂停并复位到 0（即梦的行为）。 */
  const stopPlayback = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  }, []);

  return (
    <div
      className="create-record__cell create-record__cell--video"
      onMouseEnter={startPlayback}
      onMouseLeave={stopPlayback}
    >
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        loop
        onClick={(event) => onPreview(position, event.currentTarget)}
        onKeyDown={(event) => {
          /* 与图片格同一套键盘语义：这一格能点开详情，就得能被键盘走到。 */
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onPreview(position, event.currentTarget);
        }}
        role="button"
        tabIndex={0}
        aria-label={`查看第 ${position + 1} 个视频产物`}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
        }}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {tools}
      <RecordVideoPlayer
        playing={playing}
        currentTime={currentTime}
        duration={duration}
        onToggle={toggle}
        onSeek={seek}
        onFullscreen={fullscreen}
      />
    </div>
  );
}

/**
 * 记录抬头：提示词 + 参数标签（模型 / 比例 / 分辨率 …）+ 详细信息。
 *
 * ── 长提示词的展开层（即梦活体实测 2026-10-22）────────────────────
 * 即梦的提示词区默认只显示 **2 行**（`.prompt-suffix-labels-j3vb4p`：
 * `max-height: calc(var(--line-height)*2)`、`overflow:hidden`、
 * `padding: 4px 6px`），提示词溢出时鼠标悬停就展开成一块**可滚动浮层**：
 *
 * ```css
 * .prompt-suffix-labels-j3vb4p.hovered-vOe5cq {
 *   background: var(--bg-dropdown-menu);            -- #262626
 *   border-radius: 8px;
 *   box-shadow: var(--shadow-generator-float-block);
 *   max-height: calc(var(--line-height)*10);         -- 240px = 10 行
 *   overflow-y: auto;
 *   z-index: 10;
 * }
 * ```
 * 展开时浮层盖住同行的参数标签，右下角绝对定位一枚「⧉ 使用提示词」文字按钮
 * （`.absolute-position-WbEPuP`: `right:4px; bottom:4px; z-index:5`，
 * 文字 rgba(255,255,255,.6)、14px/24px，图标 16×16）——
 * 点它把这段提示词填进浮坞的输入框。
 */
function RecordLabels({
  record,
  title,
  renamed,
  onUsePrompt,
}: {
  readonly record: CreateRecord;
  /** 抬头显示的标题：重命名后是用户起的新名字，否则是提示词。 */
  readonly title: string;
  readonly renamed: boolean;
  /** 「使用提示词」：把这段提示词填进浮坞输入框。 */
  readonly onUsePrompt?: ((prompt: string) => void) | undefined;
}) {
  const labels = [record.modelName, ...record.parameterLabels];
  const contentRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [hovered, setHovered] = useState(false);

  /*
   * 提示词是否超出两行。
   *
   * 量的是**内容**的高度（`.create-record__prompt-content` 的自然高度），
   * 不是它自己的 `clientHeight`：内容元素本身没有被裁切，`scrollHeight`
   * 与 `clientHeight` 永远相等，早前那版判定恒为 false，「使用提示词」按钮
   * 于是永远不出现（裁切发生在父级面板上）。
   *
   * 阈值取自**折叠态**的面板几何：面板高度减去内边距，就是「两行」能放下的
   * 高度。**只在折叠态更新阈值**——展开态下面板被撑到 240px，拿它当阈值会
   * 把长提示词误判成「不溢出」，展开层里的按钮会跟着消失。
   */
  useEffect(() => {
    const content = contentRef.current;
    const panel = panelRef.current;
    if (content === null || panel === null) return;
    const measure = (): void => {
      if (hovered) return;
      const style = window.getComputedStyle(panel);
      const padding =
        Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      if (!Number.isFinite(padding)) return;
      const visible = panel.clientHeight - padding;
      setOverflowing(content.scrollHeight > visible + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hovered, title, record.prompt]);

  return (
    <div className="create-record__labels" data-hovered={hovered ? "true" : "false"}>
      <div
        className="create-record__prompt-panel"
        ref={panelRef}
        data-overflowing={overflowing ? "true" : "false"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span className="create-record__prompt-content" ref={contentRef}>
          <span className="create-record__prompt" title={renamed ? record.prompt : undefined}>
            {title}
          </span>
          <span className="create-record__label-group">
            {labels.map((label) => (
              <span key={label} className="create-record__label">
                {label}
              </span>
            ))}
            <RecordDetail record={record} />
          </span>
        </span>
        {/*
         * 「使用提示词」只在**展开态**出现（即梦是绝对定位在展开层右下角；
         * 折叠态那一枚是行内的、位置不一样，这里不做两套形态）。
         */}
        {hovered && overflowing && onUsePrompt !== undefined ? (
          <button
            type="button"
            className="create-record__use-prompt"
            onClick={() => onUsePrompt(record.prompt)}
          >
            <JimengIcon name="usePrompt" />
            使用提示词
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RecordActions({
  record,
  onRegenerate,
  onEdit,
  onDelete,
}: {
  readonly record: CreateRecord;
  readonly onRegenerate: (record: CreateRecord) => void;
  readonly onEdit: (record: CreateRecord) => void;
  readonly onDelete: (record: CreateRecord) => void;
}) {
  return (
    <div className="create-record__actions">
      <button type="button" className="create-record__action" onClick={() => onEdit(record)}>
        <Icon name="pencil-simple" size="xs" aria-hidden="true" />
        重新编辑
      </button>
      <button type="button" className="create-record__action" onClick={() => onRegenerate(record)}>
        <Icon name="arrows-clockwise" size="xs" aria-hidden="true" />
        再次生成
      </button>
      <RecordMenu record={record} onDelete={onDelete} />
    </div>
  );
}

/**
 * 文本生成的产物：正文，不是媒体格子。
 *
 * 文本任务没有 `results`（媒体产物），交付物是模型回答本身。少了这一段，
 * 记录卡只剩一个空格子——用户看到的是「生成了但什么都没有」。
 */
function RecordText({ record }: { readonly record: CreateRecord }) {
  const [copied, setCopied] = useState(false);
  const text = record.textOutput ?? "";
  return (
    <div className="create-record__text">
      <p className="create-record__text-body">{text}</p>
      <div className="create-record__actions">
        <button
          type="button"
          className="create-record__action"
          onClick={() => {
            void copyTextToClipboard(text).then(
              () => setCopied(true),
              () => {
                setCopied(false);
                toast.error("复制失败", { description: "正文没有写进剪贴板，请手动选中复制。" });
              },
            );
          }}
        >
          <Icon name="copy" size="xs" aria-hidden="true" />
          {copied ? "已复制" : "复制正文"}
        </button>
      </div>
    </div>
  );
}

function PendingGrid({ record }: { readonly record: CreateRecord }) {
  const total = Math.max(record.expectedCount, record.results.length, 1);
  const finished = record.results.length;
  const slots = placeholderCount(total, finished);
  const variant = resolveRecordVariant(record.status);
  const hint =
    variant === "relax-queue"
      ? CREATE_COPY.queued
      : record.status === "retry_wait"
        ? CREATE_COPY.retrying
        : CREATE_COPY.generating(finished, total);
  return (
    <>
      <div className="create-record__status" role="status">
        <Icon name="circle-notch" size="xs" data-spin="true" aria-hidden="true" />
        <span>{hint}</span>
      </div>
      <div className="create-record__media" data-kind="image">
        {Array.from({ length: slots }, (_, index) => (
          <div
            key={index}
            className="create-record__cell create-record__skeleton"
            aria-hidden="true"
          />
        ))}
      </div>
    </>
  );
}

function RecordCard({
  record,
  title,
  renamed,
  onRegenerate,
  onEdit,
  onDelete,
  onPreview,
  onUseAsReference,
  onGenerateVideo,
  onUsePrompt,
  onCancel,
}: {
  readonly record: CreateRecord;
  readonly title: string;
  readonly renamed: boolean;
  readonly onRegenerate: (record: CreateRecord) => void;
  readonly onEdit: (record: CreateRecord) => void;
  readonly onDelete: (record: CreateRecord) => void;
  readonly onPreview: (record: CreateRecord, index: number, trigger: HTMLElement) => void;
  readonly onUseAsReference?: ((result: CreateResultItem) => void) | undefined;
  readonly onGenerateVideo?: ((result: CreateResultItem) => void) | undefined;
  readonly onUsePrompt?: ((prompt: string) => void) | undefined;
  readonly onCancel?: ((record: CreateRecord) => void) | undefined;
}) {
  const variant = resolveRecordVariant(record.status);

  if (variant === "failed") {
    const moderation = isModerationFailure(errorText(record.error));
    // unknown（结果未知、可能已计费）要说清「先去核对再决定要不要重试」，
    // 否则用户会看着「生成失败，可重新生成」就再点一次 → 真实重复扣费。
    const unknown = record.status === "unknown";
    return (
      <article className="create-record">
        <RecordLabels record={record} title={title} renamed={renamed} onUsePrompt={onUsePrompt} />
        {/*
         * unknown 必须有标题：只有一段长提示时，用户读不出这是「结果未知」而不是普通失败，
         * 而 unknown 的语义是**可能已经计费** —— 一眼看不出来就会顺手再点一次生成 → 重复扣费。
         * 标题写进 CREATE_COPY.unknownResultTitle，不在组件里另写一份文案。
         */}
        <ErrorAlert
          error={record.error}
          label={unknown ? CREATE_COPY.unknownResultTitle : undefined}
          hint={
            unknown
              ? CREATE_COPY.unknownResultHint
              : moderation
                ? CREATE_COPY.moderationFailed
                : CREATE_COPY.creditsRefunded
          }
        />
      </article>
    );
  }

  if (variant === "loading" || variant === "relax-queue") {
    return (
      <article className="create-record">
        <RecordLabels record={record} title={title} renamed={renamed} onUsePrompt={onUsePrompt} />
        <PendingGrid record={record} />
        {/*
         * 在途任务要能中止。
         *
         * 之前创作台**没有取消入口**（后端命令与前端封装都在，只有任务历史面板在用）
         * → 用户提交的任务只能干等，或者去另一个窗口的历史面板找。
         * 取消只停本机的轮询与落盘，供应商侧的任务仍可能继续并计费 —— 文案要写清。
         */}
        {onCancel != null ? (
          <div className="create-record__actions">
            <button
              type="button"
              className="create-record__action"
              onClick={() => onCancel(record)}
            >
              <Icon name="x" size="xs" aria-hidden="true" />
              取消生成
            </button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className="create-record">
      <RecordLabels record={record} title={title} renamed={renamed} onUsePrompt={onUsePrompt} />
      {record.textOutput != null && record.textOutput.trim() !== "" ? (
        <RecordText record={record} />
      ) : (
        <RecordMedia
          record={record}
          onPreview={(index, trigger) => onPreview(record, index, trigger)}
          onUseAsReference={onUseAsReference}
          onGenerateVideo={onGenerateVideo}
        />
      )}
      <RecordActions
        record={record}
        onRegenerate={onRegenerate}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </article>
  );
}

export function CreateRecordList({
  records,
  now,
  filter,
  search,
  onRegenerate,
  onEdit,
  onUseAsReference,
  onGenerateVideo,
  onUsePrompt,
  onCancel,
}: CreateRecordListProps) {
  const [preview, setPreview] = useState<{
    readonly record: CreateRecord;
    readonly index: number;
    /** 打开详情的那个媒体元素：关闭后焦点要还回去。 */
    readonly trigger: HTMLElement | null;
  } | null>(null);
  /**
   * 已被用户移除的记录。
   *
   * 后端没有删除生成任务的接口（只有 `rename_generation_result` 这类改名入口），
   * 所以删除先落在会话里：从记录流里拿掉，并如实告诉用户刷新历史后会回来。
   */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * 重命名后的记录名。
   *
   * 后端把名字落在**产物**上（`generation_result_names` 表），记录本身没有可写的
   * 名字字段，所以抬头这一行自己再记一份，重命名后立刻能看见。
   */
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(
    () => new Map<string, string>(),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (removedIds.has(record.taskId)) return false;
      if (filter !== "all" && !hasMediaType(record, filter)) return false;
      if (keyword === "") return true;
      const title = titles.get(record.taskId) ?? record.prompt;
      return (
        title.toLocaleLowerCase().includes(keyword) ||
        record.prompt.toLocaleLowerCase().includes(keyword)
      );
    });
  }, [filter, records, removedIds, search, titles]);

  const groups = useMemo(() => {
    const buckets = new Map<string, CreateRecord[]>();
    for (const record of visible) {
      const label = groupDayLabel(record.createdAt, now);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(record);
      else buckets.set(label, [record]);
    }
    return [...buckets.entries()].map(([label, items]) => ({ label, records: items }));
  }, [now, visible]);

  const handleDelete = useCallback((record: CreateRecord): void => {
    setRemovedIds((previous) => new Set(previous).add(record.taskId));
    toast.success("已移除该记录", {
      description: "后端暂未接入任务删除，这条记录只在本页隐藏；刷新历史后会重新出现。",
    });
  }, []);

  const handleRename = useCallback(async (record: CreateRecord, name: string): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("名称不能为空");
    /*
     * 后端唯一支持的重命名入口是「给产物命名」（rename_generation_result），
     * 记录本身没有可写的名字字段。记录里的每个已保存产物都改成同一个名字，
     * 抬头这一行的显示名另存在本地 state 里。
     */
    const targets = record.results.filter((result) => result.saveStatus === "succeeded");
    if (targets.length === 0) throw new Error("该记录没有已保存的产物，暂时无法命名。");
    await Promise.all(
      targets.map((result) => renameGenerationResult(record.taskId, result.resultIndex, trimmed)),
    );
    setTitles((previous) => new Map(previous).set(record.taskId, trimmed));
  }, []);

  if (visible.length === 0) {
    const removedAll =
      records.length > 0 && records.every((record) => removedIds.has(record.taskId));
    return (
      <div className="create-records create-records--empty">
        <Icon name="sparkle" size="3xl" aria-hidden="true" />
        <div className="create-records__empty-title">
          {records.length === 0
            ? CREATE_COPY.emptyTitle
            : removedAll
              ? "记录已移除"
              : "没有匹配的记录"}
        </div>
        <div className="create-records__empty-hint">
          {records.length === 0
            ? CREATE_COPY.emptyHint
            : removedAll
              ? "你移除的记录不再显示在这里。"
              : "换个关键词或筛选条件再看看。"}
        </div>
      </div>
    );
  }

  return (
    <div className="create-records" ref={rootRef}>
      {groups.map((group) => (
        <section key={group.label} className="create-records__group">
          <h2 className="create-records__title">{group.label}</h2>
          {group.records.map((record) => {
            const renamedTitle = titles.get(record.taskId);
            return (
              <RecordCard
                key={record.taskId}
                record={record}
                title={renamedTitle ?? record.prompt}
                renamed={renamedTitle !== undefined}
                onRegenerate={onRegenerate}
                onEdit={onEdit}
                onDelete={handleDelete}
                onPreview={(record, index, trigger) => setPreview({ record, index, trigger })}
                onUseAsReference={onUseAsReference}
                onGenerateVideo={onGenerateVideo}
                onUsePrompt={onUsePrompt}
                onCancel={onCancel}
              />
            );
          })}
        </section>
      ))}
      <button
        type="button"
        className="create-records__back-to-bottom"
        onClick={() => {
          /*
           * 真正的滚动容器是 `.create-content`（记录流自身没有 overflow，
           * 内容列才是 `overflow-y: auto` 的那一个）。早前写成了 `.create-records`，
           * 点了没有任何反应。
           */
          const container = rootRef.current?.closest(".create-content");
          if (!(container instanceof HTMLElement)) return;
          container.scrollTo?.({ top: container.scrollHeight, behavior: "smooth" });
        }}
      >
        回到底部
      </button>
      {preview ? (
        <CreateDetailView
          record={preview.record}
          title={titles.get(preview.record.taskId) ?? preview.record.prompt}
          index={preview.index}
          returnFocusTo={preview.trigger}
          onIndexChange={(index) =>
            setPreview((previous) => (previous === null ? previous : { ...previous, index }))
          }
          onClose={() => setPreview(null)}
          onUseAsReference={onUseAsReference}
          onGenerateVideo={onGenerateVideo}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onRename={handleRename}
        />
      ) : null}
    </div>
  );
}
