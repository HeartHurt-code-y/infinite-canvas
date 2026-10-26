/*
 * 产物菜单的**数据**部分（与浮层组件分开，避免一个文件既导出组件又导出函数）。
 *
 * 即梦活体实测（2026-10-22）：
 *   图片：复制 / 用作参考图 / 创建主体 / ── / 发布 / 删除 / 举报
 *   视频：    用作参考视频 / 创建主体 / ── / 发布 / 删除 / 举报
 * （视频没有「复制」；「创建主体」与「发布」之间有一道分隔线
 *   `.operation-menu-divider-QRo0ov`。）
 *
 * 本项目能真做的只有「用作参考图/视频」；其余按约定保留入口 + 明确说明。
 */
import { toast } from "../../lib/toast";
import type { JimengIconName } from "./JimengIcon";

/** 浮层里的一项。 */
export interface RecordMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  readonly hint: string;
  readonly disabled: boolean;
  /** 这项前面带一道分隔线。 */
  readonly dividerBefore: boolean;
  /** 「多角度」那枚 New 角标。 */
  readonly isNew: boolean;
  /** 点下去要做什么。 */
  readonly onSelect: () => void;
}

/** 即梦的产物菜单条目表。 */
const PRODUCT_MENU: readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  readonly hint: string;
  /** 只在图片产物菜单里出现。 */
  readonly imageOnly?: boolean;
  /** 这道分隔线在「创建主体」与「发布」之间。 */
  readonly dividerBefore?: boolean;
  readonly usable: boolean;
}[] = [
  {
    id: "copy",
    label: "复制",
    icon: "assetCopy",
    hint: "后端暂未接入",
    imageOnly: true,
    usable: false,
  },
  {
    id: "as-reference",
    label: "用作参考图",
    icon: "toolAsReferenceImage",
    hint: "产物还没落到本机，暂时不能作为参考素材",
    usable: true,
  },
  {
    id: "create-subject",
    label: "创建主体",
    icon: "assetCreateSubject",
    hint: "主体体系后端暂未接入",
    usable: false,
  },
  {
    id: "publish",
    label: "发布",
    icon: "assetPublish",
    hint: "后端暂未接入",
    dividerBefore: true,
    usable: false,
  },
  { id: "delete", label: "删除", icon: "assetTrash", hint: "后端暂未接入", usable: false },
  { id: "report", label: "举报", icon: "assetReport", hint: "后端暂未接入", usable: false },
];

/**
 * 造一份产物菜单的条目表。
 *
 * @param kind 产物媒体类型：图片才有「复制」。
 * @param local 产物是否已落到本机（没落盘就不能当参考素材）。
 * @param onUseReference 「用作参考图/视频」的动作。
 */
export function productMenuEntries(
  kind: "image" | "video",
  local: boolean,
  onUseReference: (() => void) | undefined,
): readonly RecordMenuEntry[] {
  const isVideo = kind === "video";
  return PRODUCT_MENU.filter((item) => !(item.imageOnly === true && isVideo)).map((item) => {
    const isReference = item.id === "as-reference";
    return {
      id: item.id,
      label: isVideo && isReference ? "用作参考视频" : item.label,
      icon: item.icon,
      hint: item.hint,
      disabled: !item.usable || (isReference && (!local || onUseReference === undefined)),
      dividerBefore: item.dividerBefore === true,
      isNew: false,
      onSelect: () => {
        if (isReference) {
          if (local && onUseReference !== undefined) {
            onUseReference();
            return;
          }
          toast(item.hint);
          return;
        }
        toast(item.hint);
      },
    };
  });
}
