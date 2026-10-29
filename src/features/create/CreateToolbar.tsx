import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { toast } from "../../lib/toast";
import type { ModelParameterCapability, ModelParameterValue } from "../../lib/modelCapabilities";
import { CreateModeIcon } from "./createModeIcons";
import { CreateModelSelect } from "./CreateModelSelect";
import { CreateParamControl } from "./CreateParamControls";
import { CreateSelect } from "./CreateSelect";
import {
  groupCapabilities,
  modeOperations,
  summarizeCount,
  summarizeDuration,
  summarizeParameterParts,
  hasAiMark as hasAiMarkValue,
  type CreateModeId,
  type ParameterGroup,
} from "./createModel";
import { AGENT_MODE_ENTRY_VALUE, AGENT_COPY, AGENT_CREATION_MODES } from "./createAgentModel";
import { JimengIcon, type JimengIconName } from "./JimengIcon";
import type { CreateModelOption } from "./useCreateSession";

/**
 * 「创作类型」下拉的**值域**。
 *
 * 下拉项的 value 与选中态（`CreateModeId`）必须是**同一套 id**。
 * 之前下拉项用的是即梦的 option value（agentic / image / video / music /
 * audio / digitalHuman / actionCopy），选中态传的是本项目的 `CreateModeId`
 * （image / video / text / speech），两套 id 只在 image / video / text 上重合：
 * 「音频生成」那一项对不上，`CreateSelect` 就回落到第一项，工具条上那枚按钮
 * 的文案显示成「Agent 模式」，前置图标却是音频波形——语义完全错位。
 *
 * 现在的约定：
 *   · 已接入的类型 → 直接用 `CreateModeId`（即梦的 `audio` 对应本项目的
 *     `speech`，后端操作名是 `speech_generation`）；
 *   · 「Agent 模式」→ 哨兵值 `AGENT_MODE_ENTRY_VALUE`（它只切浮坞形态，
 *     不是一种生成操作）；
 *   · 后端未接入的三项（音乐 / 数字人 / 动作模仿）→ 保留即梦的 id，
 *     在 `onChange` 里被认出来，给出「后端暂未接入」的说明。
 */
const ENTRY_VALUE_TO_MODE: Readonly<Record<string, CreateModeId | undefined>> = {
  image: "image",
  video: "video",
  speech: "speech",
  text: "text",
};

/** 即梦创作类型 id → 下拉项的 value（即梦的 `audio` 对应本项目的 `speech`）。 */
const CREATION_TYPE_TO_ENTRY_VALUE: Readonly<Record<string, string>> = {
  image: "image",
  video: "video",
  audio: "speech",
};

/** 即梦创作类型 → 图标（路径取自原站下拉项）。 */
const CREATION_TYPE_ICON = {
  agentic: "creationTypeAgentic",
  image: "creationTypeImage",
  video: "creationTypeVideo",
  music: "creationTypeMusic",
  audio: "creationTypeAudio",
  digitalHuman: "creationTypeDigitalHuman",
  actionCopy: "creationTypeActionCopy",
} as const satisfies Record<string, JimengIconName>;

export interface CreateToolbarProps {
  readonly mode: CreateModeId;
  readonly onModeChange: (mode: CreateModeId) => void;
  /**
   * 切到 Agent 模式。
   *
   * 实测：即梦的「创作类型」下拉在两个浮坞里是同一份 7 项清单，
   * 选「Agent 模式」就换到 Agent 浮坞。标准浮坞因此也需要一个入口项。
   * 不给这个 prop 时不显示该项（普通创作页保持原样）。
   */
  readonly onSelectAgentMode?: (() => void) | undefined;
  readonly model: CreateModelOption | null;
  readonly models: readonly CreateModelOption[];
  readonly onModelChange: (model: CreateModelOption) => void;
  readonly capabilities: readonly ModelParameterCapability[];
  readonly values: Readonly<Record<string, ModelParameterValue>>;
  readonly onParameterChange: (key: string, value: ModelParameterValue) => void;
  readonly canSubmit: boolean;
  readonly submitting: boolean;
  readonly disabledHint: string | null;
  /**
   * 提交失败的报错 id（页面上的 ErrorAlert）。
   *
   * 提交键用它做 `aria-describedby`：键盘用户走到提交键就知道刚才为什么失败。
   */
  readonly submitErrorId?: string | undefined;
  readonly onSubmit: () => void;
  /**
   * 打开主体选择器（即梦普通创作档工具条上的 `@ 主体` 按钮）。
   *
   * 回调带上触发元素：浮层按它贴靠——即梦那枚按钮点开的是同一块
   * 240 宽的浮层，锚点就是按钮本身。
   */
  readonly onOpenSubjects?: ((anchor: HTMLElement) => void) | undefined;
}

/** 能力模式下拉：对应即梦的「全能参考 / 首尾帧 / 智能多帧 / 智能编辑 / 超长视频」。 */
function AbilitySelect({
  group,
  value,
  onChange,
}: {
  readonly group: ParameterGroup;
  readonly value: ModelParameterValue | undefined;
  readonly onChange: (key: string, value: ModelParameterValue) => void;
}) {
  const capability = group.capabilities[0];
  if (!capability) return null;
  const current = value ?? capability.defaultValue;
  return (
    <CreateSelect
      ariaLabel="能力模式"
      icon={<JimengIcon name="abilityIcon" />}
      value={String(current)}
      options={capability.options.map((option) => ({
        value: String(option.value),
        label: option.label,
      }))}
      /* 这是能力模式下拉，不是模型下拉：陈旧 id 时不能显示「默认模型」。 */
      fallbackLabel="默认模式"
      onChange={(id) => {
        const picked = capability.options.find((option) => String(option.value) === id);
        if (picked) onChange(capability.key, picked.value);
      }}
    />
  );
}

/**
 * 创作台底部参数工具条。
 *
 * 结构与即梦创作页一一对应（实测顺序）：
 *   创作类型 → 模型 → 能力模式 → 参数（比例/分辨率/数量）→ 时长 → 提交
 *
 * 所有浮层都挂在 document.body 上：工具条本身是横向滚动容器
 * （`overflow-x: auto`），浮层留在工具条里会被祖先裁掉——这就是
 * 「模型和参数点不动」的历史根因。
 */
export function CreateToolbar({
  mode,
  onModeChange,
  onSelectAgentMode,
  model,
  models,
  onModelChange,
  capabilities,
  values,
  onParameterChange,
  canSubmit,
  submitting,
  disabledHint,
  submitErrorId,
  onSubmit,
  onOpenSubjects,
}: CreateToolbarProps) {
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const settingsRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupCapabilities(capabilities), [capabilities]);
  const abilityGroup = groups.find((group) => group.id === "ability");
  const durationGroup = groups.find((group) => group.id === "duration");
  /*
   * 比例与分辨率合在一个按钮；**数量是否单列取决于创作类型**。
   *
   * 即梦两档的结构不一样（本轮活体实测）：
   *   · 图片档（`?type=image`）：创作类型 → 模型 → 「智能比例2K」(115)
   *     → 「2张」(55，独立浮层 320×97 / 8 个 34×36 数字磁贴)
   *     → 文字效果增强 → @主体 → 生成
   *   · 视频档（`?type=video`）：创作类型 → 模型 → 能力模式
   *     → 「16:9 480P 1」（比例+分辨率+数量**三合一**）
   *     → 「5s」（时长滑杆）→ 生成
   * 所以数量只在图片档拆出来单列；视频档保持三合一，跟原站一致。
   */
  const countStandsAlone = mode === "image";
  /* 即梦的「文字效果增强」只在图片档；参数按钮的画框图标也只在图片档。 */
  const isImageMode = mode === "image";
  const parameterGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.id === "ratio" ||
          group.id === "resolution" ||
          (!countStandsAlone && group.id === "count"),
      ),
    [countStandsAlone, groups],
  );
  const countGroup = countStandsAlone ? groups.find((group) => group.id === "count") : undefined;
  const durationKeys = useMemo(() => new Set(["duration"]), []);
  const summary = useMemo(
    () => summarizeParameterParts(capabilities, values, durationKeys),
    [capabilities, durationKeys, values],
  );
  /** 即梦那枚蓝色 ✦：当前参数里有 AI 能力标记时才挂。 */
  const hasAiMark = useMemo(
    () => hasAiMarkValue(capabilities, values, durationKeys),
    [capabilities, durationKeys, values],
  );
  const countSummary = useMemo(() => summarizeCount(capabilities, values), [capabilities, values]);
  const durationSummary = useMemo(
    () => summarizeDuration(capabilities, values),
    [capabilities, values],
  );

  /*
   * 创作类型下拉。
   *
   * **即梦两个浮坞用的是同一个下拉组件**，都是那 7 项（实测顺序）：
   *   Agent 模式 → 图片生成 → 视频生成 → 音乐生成 → 音频生成 → 数字人 → 动作模仿
   * 每项左侧一枚 16×16 图标（路径取自原站下拉项）。
   *
   * 本项目的对应关系：
   *   · 图片 / 视频 / 音频 → 本项目直接支持（即梦的 audio 就是我们的「音频生成」，
   *     下拉项的 value 用本项目的 mode id，见 `ENTRY_VALUE_TO_MODE`）；
   *   · 音乐 / 数字人 / 动作模仿 → 后端未接入，照即梦的「列出来 + 标注」规矩
   *     给出「后端暂未接入」角标，点下去给说明（不是藏起来，也不是点了报错）；
   *   · 「文本生成」是本项目**多出来**的一项（即梦没有），放在最后。
   */
  const modeEntries = useMemo(() => {
    const entries: {
      value: string;
      label: string;
      icon: React.ReactNode;
      badge?: string;
    }[] = AGENT_CREATION_MODES.map((item) => ({
      value: CREATION_TYPE_TO_ENTRY_VALUE[item.id] ?? item.id,
      label: item.label,
      icon: <JimengIcon name={CREATION_TYPE_ICON[item.id] ?? "creationTypeAgentic"} />,
      ...(item.implemented ? {} : { badge: AGENT_COPY.modePendingBadge }),
    }));
    if (onSelectAgentMode !== undefined) {
      /*
       * 「Agent 模式」已经在 `AGENT_CREATION_MODES` 的第一项（即梦的顺序），
       * 这里只把它标成「切浮坞」用的入口值，不再插一条重复项。
       */
      const agenticIndex = entries.findIndex((entry) => entry.value === "agentic");
      if (agenticIndex >= 0) {
        const entry = entries[agenticIndex];
        if (entry !== undefined) {
          entries[agenticIndex] = { ...entry, value: AGENT_MODE_ENTRY_VALUE };
        }
      }
    }
    /* 本项目额外的「文本生成」（即梦的清单里没有）。 */
    entries.push({
      value: "text",
      label: "文本生成",
      icon: <Icon name="text-aa" size="xs" aria-hidden="true" />,
    });
    return entries;
  }, [onSelectAgentMode]);
  /**
   * 模型列表：只留下能服务当前创作类型的模型。
   *
   * 图片类型同时看文生图与图生图（挂了参考素材就走图生图），
   * 只支持图生图的模型也必须能被选到。
   *
   * 平台 → 模型的二级拆分在 `CreateModelSelect` 里做，这里只负责
   * 「当前创作类型能用哪些模型」。
   */
  const modeModels = useMemo(() => {
    const operations = modeOperations(mode);
    return models.filter((item) =>
      item.operations.some((operation) => operations.includes(operation)),
    );
  }, [mode, models]);

  /*
   * 参数装不下时的滚动边缘。
   *
   * 即梦实测（CSS 分包 `css/async/420`）：参数区是 `overflow:auto` 的横向滚动
   * 容器，左右两侧各有一个 64px 宽的绝对定位浮层（`.scroll-button-container`），
   * 里面的按钮默认 `opacity:0`，**容器 hover 时才 `opacity:1`**；
   * 同时滚动区按「还能往哪边滚」挂 `left-scrollable` / `right-scrollable` 类，
   * 用 `mask-image` 做边缘渐隐：
   *   · 只有左侧可滚：linear-gradient(90deg, transparent, #000 32px)
   *   · 只有右侧可滚：linear-gradient(270deg, transparent, #000 32px)
   *   · 两边都可滚：linear-gradient(90deg, transparent 32px, #000 calc(100% - 64px), transparent calc(100% - 32px))
   * hover 时渐隐带整体向内收 32px（边缘留一条实透的带），按钮浮上来。
   */
  useEffect(() => {
    const element = settingsRef.current;
    if (!element) return;
    const update = (): void => {
      const max = element.scrollWidth - element.clientWidth;
      setScrollEdges({
        left: element.scrollLeft > 1,
        right: max > 1 && element.scrollLeft < max - 1,
      });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [groups.length, modeEntries.length, modeModels.length]);

  /** 按方向滚动参数区半屏（与即梦的滚动按钮一致）。 */
  const scrollSettings = useCallback((direction: -1 | 1): void => {
    const element = settingsRef.current;
    if (!element) return;
    element.scrollBy({ left: (direction * element.clientWidth) / 2, behavior: "smooth" });
  }, []);

  return (
    <div className="create-toolbar">
      {/*
       * 参数区外壳：滚动容器与两块滚动浮层的共同父级。
       *
       * 浮层必须以**参数区**为定位基准，不能以整条工具条为基准：
       * 之前它们是 `.create-toolbar`（position: relative）的绝对定位子元素，
       * `right: 0` 落在整条工具条的右缘——那里正好是动作区（消耗位 + 提交键）。
       * 那枚 `opacity: 0` 的滚动按钮因此**完全盖在提交键上**（实测两者矩形
       * 只差 3px），点击全被它吃掉：它只 scrollBy 参数区，参数没溢出时什么
       * 也不发生，于是表现为「点发送没反应」，后端连一条日志都没有。
       */}
      <div className="create-toolbar__params">
        <div
          className="create-toolbar__settings"
          ref={settingsRef}
          data-scroll-left={scrollEdges.left ? "true" : "false"}
          data-scroll-right={scrollEdges.right ? "true" : "false"}
        >
          <CreateSelect
            primary
            ariaLabel="创作类型"
            /*
             * 标题「创作类型」：即梦的创作类型下拉**有**标题（i18n key
             * `web_home_tool_dropdown_title`，实测 aria-label 同名）。
             * 上一版只有 Agent 浮坞带标题，普通浮坞漏了。
             *
             * 即梦的模型/参数下拉**没有**标题；本项目的模型下拉拆成
             * 「平台 → 模型」两级之后，两枚都带标题（见 `CreateModelSelect`），
             * 否则并排两枚下拉分不清谁是谁。
             */
            title="创作类型"
            value={mode}
            options={modeEntries}
            /* 这是创作类型下拉，不是模型下拉：陈旧 id 时不能显示「默认模型」。 */
            fallbackLabel="创作类型"
            onChange={(id) => {
              if (id === AGENT_MODE_ENTRY_VALUE) {
                onSelectAgentMode?.();
                return;
              }
              /*
               * 即梦的清单里有「音乐 / 数字人 / 动作模仿」，本项目后端没接。
               * 照即梦的规矩「列出来 + 标注」，点了给明确说明，不静默失败。
               *
               * 查不到映射 = 这一项不是一种本项目的创作类型（未接入的三项）。
               */
              const target = ENTRY_VALUE_TO_MODE[id];
              if (target === undefined) {
                toast(AGENT_COPY.modePending);
                return;
              }
              onModeChange(target);
            }}
            icon={<CreateModeIcon mode={mode} className="create-select__mode-icon" />}
          />
          <CreateModelSelect
            models={modeModels}
            model={model}
            onModelChange={onModelChange}
          />
          {abilityGroup ? (
            <AbilitySelect
              group={abilityGroup}
              value={values[abilityGroup.capabilities[0]?.key ?? ""]}
              onChange={onParameterChange}
            />
          ) : null}
          <CreateParamControl
            ariaLabel="生成参数"
            /*
             * 参数按钮的图标**按档位**给（即梦实测）：
             *   · 图片档「智能比例2K」：前置 16×16 画框图标；
             *   · 视频档「16:9 720P」：**没有**图标。
             */
            icon={isImageMode ? <JimengIcon name="paramsFrame" /> : undefined}
            summary={summary}
            groups={parameterGroups}
            values={values}
            onChange={onParameterChange}
            panelMinWidth={336}
            /*
             * 即梦给「AI 能力」在参数摘要末尾挂一枚蓝色 ✦（截图里是
             * 「智能比例 · 2K ✦」）。标记位由能力目录驱动：`aiMark`。
             */
            aiMark={hasAiMark}
          />
          {countGroup ? (
            <CreateParamControl
              ariaLabel="生成数量"
              icon={<JimengIcon name="countStack" />}
              summary={countSummary}
              groups={[countGroup]}
              values={values}
              onChange={onParameterChange}
              panelMinWidth={320}
            />
          ) : null}
          {durationGroup ? (
            <CreateParamControl
              ariaLabel="生成时长"
              /* 即梦视频档的「5s」按钮前置一枚时钟图标。 */
              icon={<JimengIcon name="durationIcon" />}
              summary={durationSummary}
              groups={[durationGroup]}
              values={values}
              onChange={onParameterChange}
            />
          ) : null}
          {/*
         * 「文字效果增强」与「@主体」两枚图标钮（即梦普通浮坞也有）。
         *
         * 即梦图片生成档工具条实测（左→右）：
         *   创作类型(100) → 模型(120) → 「智能比例2K」(115) → 「2张」(55)
         *   → 文字效果增强(32) → @主体(32) → 生成(32)
         * 即梦视频生成档实测：
         *   创作类型(100) → 模型(144) → 全能参考(84) → 「16:9 720P」(104)
         *   → 「5s」(49) → @主体(32) → 生成(32)
         * 即梦这两档都用即梦的图标，本地先前的通用图标库与原站形状不同，
         * 一眼能看出来。
        {/*
         * 「文字效果增强」只在**图片档**（即梦视频档没有这枚，实测如上）。
         * 「@主体」两档都有。
         *
         * 两个能力本项目后端都没有，按 AGENTS.md「Agent 模式约定」的规矩：
         * 结构定死、交互做全、点击给出明确说明，不静默失败、不藏起来。
         */}
          {isImageMode ? (
            <button
              type="button"
              className="create-toolbar__tool"
              aria-label="文字效果增强"
              onClick={() => toast("文字效果增强后端暂未接入。")}
            >
              <JimengIcon name="textEffect" />
            </button>
          ) : null}
          <button
            type="button"
            className="create-toolbar__tool"
            aria-label="添加主体"
            onClick={(event) => onOpenSubjects?.(event.currentTarget)}
          >
            <JimengIcon name="subjectIcon" />
          </button>
        </div>

        {/*
         * 左右滚动浮层（即梦 `.scroll-button-container`）。
         *
         * 即梦把这两块做成参数区**两侧**的 64px 绝对定位浮层，按钮默认透明、
         * hover 工具条才显形；渐隐交给参数区的 `mask-image`。
         *
         * 它们是参数区（`.create-toolbar__params`）的子元素，不是整条工具条的
         * 子元素——定位基准必须是参数区，否则右缘会落到动作区的提交键上。
         */}
        <div className="create-toolbar__scroll-zone create-toolbar__scroll-zone--left">
          <button
            type="button"
            className="create-toolbar__scroll"
            aria-label="向左滚动参数"
            tabIndex={scrollEdges.left ? 0 : -1}
            data-active={scrollEdges.left ? "true" : "false"}
            onClick={() => scrollSettings(-1)}
          >
            <Icon name="caret-left" size="xs" aria-hidden="true" />
          </button>
        </div>
        <div className="create-toolbar__scroll-zone create-toolbar__scroll-zone--right">
          <button
            type="button"
            className="create-toolbar__scroll"
            aria-label="向右滚动参数"
            tabIndex={scrollEdges.right ? 0 : -1}
            data-active={scrollEdges.right ? "true" : "false"}
            onClick={() => scrollSettings(1)}
          >
            <Icon name="caret-right" size="xs" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="create-toolbar__actions">
        {disabledHint ? (
          <span className="create-hint" role="status">
            {disabledHint}
          </span>
        ) : null}
        {/*
         * 消耗位（即梦 `.credit-price-display`）。
         *
         * 即梦在提交键左边放一枚「蓝色四角星 + N/张」——那是它 SaaS 的积分单价。
         * 本项目按供应商 API 计费，后端没有成本预估接口，所以这块保留**位置与外观**
         * （图标 16px、字 12px/12px Montserrat、色 rgba(255,255,255,.6)），
         * 内容如实写「待接入」，点它说明原因，不编造一个假单价。
         */}
        <button
          type="button"
          className="create-toolbar__cost"
          title="本次生成的消耗预估"
          onClick={() => toast("消耗预估后端暂未接入。")}
        >
          <JimengIcon name="creditStar" className="create-toolbar__cost-icon" />
          <span className="create-toolbar__cost-value">待接入</span>
        </button>
        <button
          type="button"
          className="create-submit"
          disabled={!canSubmit || submitting}
          aria-label={submitting ? "生成中" : "生成"}
          aria-describedby={submitErrorId}
          onClick={onSubmit}
        >
          {submitting ? (
            <Icon name="circle-notch" size="sm" data-spin="true" aria-hidden="true" />
          ) : (
            <JimengIcon name="submit" size="1.25rem" />
          )}
        </button>
      </div>
    </div>
  );
}
