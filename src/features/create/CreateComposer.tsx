/*
 * 生成页底部浮坞（对应即梦的 `dimension-layout` + `toolbar`）。
 *
 * 实测规格：
 *   - 外壳 sticky、圆角 24px、背景 linear-gradient(180deg, rgba(26,26,26,.72) 0,
 *     rgba(42,42,42,.72) 106.67%)、backdrop-filter blur(80px)、
 *     1px 边框 rgba(255,255,255,.08)、overflow hidden；
 *   - 内层 padding 16px、gap 16px；
 *   - 内容行 flex、gap 12px：左边是 64px 宽的参考条，右边是提示词区；
 *   - 提示词 14px/24 白字，占位文案 rgba(255,255,255,.35)；
 *   - 工具条高 32px、gap 12px、左右分置；参数区横向滚动，内边距 7px 0、gap 4px。
 *
 * 参数条本身复用创作台的 CreateToolbar——它就是照即梦这一排做的，
 * 两页共用一份实现，浮层的定位策略也只维护一处。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { JimengIcon } from "./JimengIcon";
import { ImeTextarea } from "../../components/ImeTextField";
import { isDesktopRuntime } from "../../lib/backend";
import { open } from "@tauri-apps/plugin-dialog";
import { CreateSubjectPicker } from "./CreateSubjectPicker";
import { CreateToolbar } from "./CreateToolbar";
import { useCreateAssetDrag } from "./createAssetDrag";
import { COMPOSER_PLACEHOLDER, CREATE_COPY, type CreateModeId } from "./createModel";
import type { AgentSubject } from "./createAgentModel";
import type { CreateModelOption, CreateReference } from "./useCreateSession";
import type { ModelParameterCapability, ModelParameterValue } from "../../lib/modelCapabilities";

export interface CreateComposerProps {
  readonly prompt: string;
  readonly onPromptChange: (value: string) => void;
  readonly references: readonly CreateReference[];
  readonly onReferencesChange: (references: readonly CreateReference[]) => void;
  /** 打开资产库抽屉（挑参考素材）。 */
  readonly onOpenAssetLibrary: () => void;
  readonly mode: CreateModeId;
  readonly onModeChange: (mode: CreateModeId) => void;
  /** 切到 Agent 模式（即梦的创作类型下拉第一项）。 */
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
   * 提交键用它做 `aria-describedby`：键盘用户走到提交键就知道刚才为什么失败，
   * 而不是只看到一个复原了的按钮。
   */
  readonly submitErrorId?: string | undefined;
  readonly onSubmit: () => void;
  /**
   * 主体列表（图片档的「主体」芯片要用）。
   *
   * 本项目后端暂未接入主体体系（`TODO(agent-subjects)`），默认是空列表，
   * 于是浮层走空态「你还没有创建过主体」+「创建主体」。
   */
  readonly subjects?: readonly AgentSubject[];
  /** 已选中的主体。 */
  readonly selectedSubjects?: readonly AgentSubject[];
  readonly onSubjectsChange?: (selected: readonly AgentSubject[]) => void;
  /** 「创建主体」：本项目暂无主体体系，给出说明而不是静默。 */
  readonly onCreateSubject?: () => void;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  const last = parts.at(-1);
  return last !== undefined && last !== "" ? last : path;
}

/** 参考素材的缩略图地址。 */
function referenceSrc(reference: CreateReference): string | null {
  if (reference.previewUrl) return reference.previewUrl;
  if (reference.kind === "local_file" && reference.path) return convertFileSrc(reference.path);
  return null;
}

export function CreateComposer({
  prompt,
  onPromptChange,
  references,
  onReferencesChange,
  onOpenAssetLibrary,
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
  subjects = [],
  selectedSubjects = [],
  onSubjectsChange = () => undefined,
  onCreateSubject = () => undefined,
}: CreateComposerProps) {
  /*
   * 占位文案按创作类型分档（见 `COMPOSER_PLACEHOLDER`）。
   */
  const placeholder = COMPOSER_PLACEHOLDER[mode];
  /*
   * 图片档那枚「主体」芯片与工具条上的 `@ 主体` 按钮，
   * 点开的是**同一块** 240 宽的主体浮层（即梦实测），所以浮层只有一个，
   * 锚点按「谁点的」来定。
   */
  const subjectAnchorRef = useRef<HTMLElement | null>(null);
  const [subjectOpen, setSubjectOpen] = useState(false);
  const openSubjects = useCallback((anchor: HTMLElement) => {
    subjectAnchorRef.current = anchor;
    setSubjectOpen(true);
  }, []);
  /*
   * 素材从资产库抽屉拖进来时的落点状态。
   *
   * 拖拽会话在模块级（createAssetDrag.ts），浮坞只读「指针是不是停在
   * 自己身上」这一位：停在上面就把浮坞点亮，并提示松手后会加为参考素材。
   */
  const dropActive = useCreateAssetDrag().overTarget;
  /*
   * 本机文件兜底入口。
   *
   * 素材库是主入口，但用户本机刚截的图还没入库时，直接选文件更省事。
   * 即梦只有素材库，本项目多留这一条——它不挤占布局，只是同一个「参考内容」
   * 按钮的长按/次级入口。放在这里是次级动作：先开素材库，长按才是文件。
   */
  const pickLocalFiles = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    const picked = await open({
      multiple: true,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const existing = new Set(references.map((item) => item.path).filter(Boolean));
    const additions = paths
      .filter((path) => !existing.has(path))
      .map((path) => ({
        kind: "local_file" as const,
        path,
        name: fileName(path),
        mediaType: "image" as const,
      }));
    if (additions.length > 0) onReferencesChange([...references, ...additions]);
  }, [onReferencesChange, references]);

  return (
    <div className="create-dock">
      <div
        className={`create-dock__surface${dropActive ? " is-drop-target" : ""}`}
        data-create-drop-zone="dock"
      >
        {dropActive ? (
          <span className="create-dock__drop-hint" aria-hidden="true">
            松开添加为参考素材
          </span>
        ) : null}
        <div className="create-dock__content">
          <div className="create-dock__references">
            {references.map((reference) => {
              const src = referenceSrc(reference);
              return (
                <div
                  key={`${reference.kind}-${reference.assetId ?? reference.path}`}
                  className="create-reference"
                >
                  {src ? (
                    <img className="create-reference__media" src={src} alt="" />
                  ) : (
                    <span
                      className="create-reference__media create-reference__media--empty"
                      aria-hidden="true"
                    >
                      <Icon name="image-square" size="xs" />
                    </span>
                  )}
                  <button
                    type="button"
                    className="create-reference__remove"
                    aria-label={`移除参考 ${reference.name}`}
                    onClick={() =>
                      onReferencesChange(references.filter((item) => item !== reference))
                    }
                  >
                    <Icon name="x" size="2xs" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="create-reference-add"
              onClick={onOpenAssetLibrary}
              onDoubleClick={() => void pickLocalFiles()}
              aria-label="从素材库添加参考内容"
            >
              <Icon name="plus" size="sm" aria-hidden="true" />
              <span className="create-reference-add__label">{CREATE_COPY.referenceTileLabel}</span>
            </button>
          </div>

          <div className="create-dock__prompt">
            {/*
              富占位符：即梦的占位文案里嵌着一枚可点的行内芯片，所以
              「输入文字或 @ 参考内容」里的「参考内容」比周围亮一倍并且能点。
              这里用覆盖层实现同一效果：输入框保持原生 textarea（中文输入法友好），
              占位文案单独一层，只有芯片可点。
            */}
            {prompt.length === 0 ? (
              <div className="create-dock__placeholder">
                <span>{placeholder.before} </span>
                {/*
                 * 行内芯片。
                 *
                 * 即梦按创作类型给不同的芯片：
                 *   · 图片档：「主体」——点开是那块 240 宽的主体选择器；
                 *   · 视频档：「参考内容」——点开是素材库。
                 * 本地照此分档：图片档复用同一套主体浮层（Agent 浮坞里也是它）。
                 */}
                {placeholder.chip === "主体" ? (
                  <button
                    type="button"
                    className="create-dock__chip"
                    aria-haspopup="listbox"
                    aria-expanded={subjectOpen}
                    onClick={(event) => openSubjects(event.currentTarget)}
                  >
                    <JimengIcon name="subject" />
                    <span className="create-dock__chip-text">{placeholder.chip}</span>
                  </button>
                ) : (
                  <button type="button" className="create-dock__chip" onClick={onOpenAssetLibrary}>
                    <JimengIcon name="subject" />
                    <span className="create-dock__chip-text">{placeholder.chip}</span>
                  </button>
                )}
                <span>{placeholder.after}</span>
              </div>
            ) : null}
            {/*
             * 主体浮层（240 宽，空态 + 创建主体）。
             *
             * 即梦普通创作页有两个入口点开它：图片档占位文案里的「主体」芯片、
             * 工具条上的 `@ 主体` 按钮——**同一块浮层**，锚点按谁点的来定。
             * 视频档的占位芯片是「参考内容」（开素材库），但工具条那枚按钮
             * 仍然开主体浮层，所以浮层一直挂载。
             */}
            <CreateSubjectPicker
              trigger={null}
              anchorRef={subjectAnchorRef}
              subjects={subjects}
              selected={selectedSubjects}
              onChange={onSubjectsChange}
              onCreateSubject={onCreateSubject}
              open={subjectOpen}
              onOpenChange={setSubjectOpen}
            />
            <ImeTextarea
              value={prompt}
              onValueChange={onPromptChange}
              placeholder=""
              rows={3}
              aria-label="提示词"
            />
          </div>
        </div>

        <CreateToolbar
          mode={mode}
          onModeChange={onModeChange}
          onSelectAgentMode={onSelectAgentMode}
          model={model}
          models={models}
          onModelChange={onModelChange}
          capabilities={capabilities}
          values={values}
          onParameterChange={onParameterChange}
          canSubmit={canSubmit}
          submitting={submitting}
          disabledHint={disabledHint}
          submitErrorId={submitErrorId}
          onSubmit={onSubmit}
          onOpenSubjects={openSubjects}
        />
      </div>
    </div>
  );
}
