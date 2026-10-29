/*
 * 创作台的模型选择：先选平台、再选模型（两级）。
 *
 * 为什么拆成两级：
 *   目录里同一个模型可能挂在多个供应商连接下（同名模型、不同来路）。
 *   把所有平台的所有模型塞进一个下拉，用户只能靠一行灰色小字
 *   （「平台 · 远端模型 ID」）分辨自己在选哪个——几十条同名项，
 *   选中之前根本看不出区别。
 *
 * 两级之后：平台下拉只列平台（顺带写明该平台有几个模型），
 * 模型下拉只列**当前平台**下的模型。
 *
 * 换平台会顺带切到那个平台的第一个模型：不切的话，模型下拉里会出现
 * 「当前模型不在列表里」的陈旧态，触发器上显示的模型名与下拉里
 * 能选到的模型对不上。
 *
 * 两处都用这一个组件（底部浮坞、Agent 模式的「生成偏好」面板），
 * 口径一致：一处改完，另一处自动跟着变。
 */
import { useMemo } from "react";
import { CreateSelect } from "./CreateSelect";
import { groupModelsByPlatform } from "./createModelPlatform";
import type { CreateModelOption } from "./useCreateSession";

export interface CreateModelSelectProps {
  /** 候选模型（已按创作类型过滤）。 */
  readonly models: readonly CreateModelOption[];
  /**
   * 当前生效的模型。
   *
   * `null` 有两种含义：目录里一个模型都没有（工具条），或者
   * 「未指定模型、按目录默认模型提交」（Agent 偏好面板）。
   * 两种都按「第一个平台 + 它的第一个模型」兜底，与下拉里
   * 「未指定就显示第一项」的既有口径一致。
   */
  readonly model: CreateModelOption | null;
  readonly onModelChange: (model: CreateModelOption) => void;
  /** 平台下拉的浮层宽度。 */
  readonly platformPopoverWidth?: number;
  /** 模型下拉的浮层宽度。 */
  readonly modelPopoverWidth?: number;
  /** 平台下拉的附加类名。 */
  readonly platformClassName?: string;
  /** 模型下拉的附加类名。 */
  readonly modelClassName?: string;
  /** 容器附加类名。 */
  readonly className?: string;
}

export function CreateModelSelect({
  models,
  model,
  onModelChange,
  platformPopoverWidth = 240,
  modelPopoverWidth = 320,
  platformClassName,
  modelClassName,
  className,
}: CreateModelSelectProps) {
  const groups = useMemo(() => groupModelsByPlatform(models), [models]);
  /** 当前模型所属的平台；没有选中模型时落到第一个平台。 */
  const activeGroup = useMemo(() => {
    const platformId = model?.providerConnectionId;
    if (platformId !== undefined) {
      const matched = groups.find((group) => group.id === platformId);
      if (matched) return matched;
    }
    return groups[0] ?? null;
  }, [groups, model?.providerConnectionId]);

  const platformOptions = useMemo(
    () =>
      groups.map((group) => ({
        value: group.id,
        label: group.name,
        /* 写明这个平台下有几个模型：分类之后，「为什么只有这一个平台」不再是问号。 */
        description: `${group.models.length} 个模型`,
        /* 平台名过长时省略号收尾，悬停仍看得到全名。 */
        title: group.name,
      })),
    [groups],
  );

  const modelOptions = useMemo(
    () =>
      (activeGroup?.models ?? []).map((item) => ({
        value: item.modelDefinitionId,
        label: item.displayName,
        /*
         * 模型项不再挂第二行说明。
         *
         * 原来那一行是「平台 · 远端模型 ID」——平台已经由左边那枚下拉单独
         * 表达了，这里再写一遍就是把刚拆开的两个维度又塞回一行，
         * 还得把浮层撑到 420 宽才放得下。
         *
         * 远端模型 ID 挪到悬浮提示里：绝大多数模型的展示名就是它的远端 ID
         * （展示名只是多了个「(按次)」后缀），真正需要看原始 ID 的场景
         * （展示名是中文别名）仍然拿得到。
         *
         * 提示里同时带上完整展示名：浮层放不下时名称会省略号收尾，
         * 悬停仍能看到全名。
         */
        title:
          item.remoteModelId === item.displayName
            ? item.displayName
            : `${item.displayName}（远端模型 ID：${item.remoteModelId}）`,
      })),
    [activeGroup],
  );

  return (
    <div className={["create-model-select", className ?? ""].filter(Boolean).join(" ")}>
      <CreateSelect
        ariaLabel="平台"
        title="平台"
        value={activeGroup?.id ?? null}
        options={platformOptions}
        popoverWidth={platformPopoverWidth}
        /* 陈旧 id（平台已从目录里消失）时显示占位文案，不显示裸 id。 */
        fallbackLabel="平台"
        {...(platformClassName === undefined ? {} : { className: platformClassName })}
        onChange={(platformId) => {
          const group = groups.find((item) => item.id === platformId);
          const first = group?.models[0];
          if (first) onModelChange(first);
        }}
      />
      <CreateSelect
        ariaLabel="模型"
        title="模型"
        wide
        popoverWidth={modelPopoverWidth}
        value={model?.modelDefinitionId ?? null}
        options={modelOptions}
        /* 模型下拉里没有当前项时显示「默认模型」，别显示裸 id。 */
        fallbackLabel="默认模型"
        {...(modelClassName === undefined ? {} : { className: modelClassName })}
        onChange={(modelId) => {
          const picked = (activeGroup?.models ?? []).find(
            (item) => item.modelDefinitionId === modelId,
          );
          if (picked) onModelChange(picked);
        }}
      />
    </div>
  );
}
