import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import {
  emptyScriptShot,
  composeScriptShot,
  scriptDocument,
  scriptSourceSignature,
  scriptTableFingerprint,
  replaceScriptTable,
  restoreScriptTaskOutput,
  type ScriptAsset,
  type ScriptBatchStartRequest,
  type ScriptGeneratorState,
  type ScriptShot,
  type ScriptStep,
} from "./scriptGeneratorModel";
import { isTextGenerationModel, type ScreenplayNodeConfig, type ScreenplayNodeData } from "./workspaceModel";
import "./CanvasScriptGenerator.css";
import { ScriptHistoryRecovery } from "./ScriptHistoryRecovery";
import { ScriptBatchPanel } from "./ScriptBatchPanel";
import type { StoryboardFilmSource } from "./storyboardProject";

type ConfigUpdate = (update: (config: ScreenplayNodeConfig) => ScreenplayNodeConfig) => void;
type ShotField = Exclude<keyof ScriptShot, "id" | "composedFrom" | "assetIds" | "unresolvedAssetRefs">;

const SHOT_FIELDS: readonly [ShotField, string][] = [
  ["duration", "时长（秒）"], ["plot", "画面描述"], ["shotSize", "景别"], ["lighting", "光影氛围"],
  ["dialogue", "对白／旁白"], ["sound", "音效"], ["camera", "运镜"], ["videoPrompt", "最终视频提示词"],
  ["characters", "角色"], ["emotion", "情绪"], ["scene", "场景"], ["props", "道具"],
];
const SCRIPT_STEPS = [
  ["confirm-shots", "确认镜头"], ["prepare-assets", "准备资产"], ["compose-prompts", "合成提示词"],
] as const;
const PROMPT_FIELDS: readonly [ShotField, string][] = [
  ["imagePrompt", "图片提示词"], ["videoPrompt", "视频提示词"],
  ["imageToVideoPrompt", "图生视频运动提示词"],
];
const canCompose = (shot: ScriptShot) =>
  !shot.unresolvedAssetRefs?.length && [shot.plot, shot.characters, shot.shotSize, shot.camera, shot.scene, shot.props,
    shot.lighting, shot.sound, shot.dialogue].some((value) => value.trim());

function ShotAssetBindings({ shot, assets, running, onChange }: {
  readonly shot: ScriptShot;
  readonly assets: readonly ScriptAsset[];
  readonly running: boolean;
  readonly onChange: (ids: readonly string[], clearUnresolved?: boolean) => void;
}) {
  const selected = shot.assetIds ?? [];
  const missing = selected.filter((id) => !assets.some((asset) => asset.id === id));
  return <details className="canvas-script-editor__bindings">
    <summary>关联资产（{selected.length}）{missing.length || shot.unresolvedAssetRefs?.length ? " · 需核对" : ""}</summary>
    {assets.length ? assets.map((asset) => <label key={asset.id}>
      <input type="checkbox" checked={selected.includes(asset.id)} disabled={running}
        onChange={(event) => onChange(event.target.checked
          ? [...selected, asset.id] : selected.filter((id) => id !== asset.id))} />
      {asset.name || "未命名资产"}
    </label>) : <span>请先在准备资产中添加角色、场景或道具。</span>}
    {missing.length ? <button type="button" disabled={running} onClick={() => onChange(selected.filter((id) => !missing.includes(id)))}>
      清除已删除的资产关联（{missing.length}）
    </button> : null}
    {shot.unresolvedAssetRefs?.length ? <div>
      <p>模型返回的部分资产关联无法确认：{shot.unresolvedAssetRefs.join("、")}。请核对并选择对应资产。</p>
      <button type="button" disabled={running} onClick={() => onChange(selected, true)}>已核对，清除提示</button>
    </div> : null}
  </details>;
}

export function CanvasScriptTryActions({ onStory, onCharacter, onManual }: {
  readonly onStory: () => void;
  readonly onCharacter: () => void;
  readonly onManual: () => void;
}) {
  const actions = [
    { label: "剧本生成分镜脚本", icon: "text-align-center" as const, run: onStory },
    { label: "角色生成分镜脚本", icon: "perspnal-n" as const, run: onCharacter },
    { label: "自己编写分镜脚本", icon: "text-file" as const, run: onManual },
  ];
  return (
    <div className="canvas-text-try canvas-text-try--compact canvas-script-try">
      <LibTVMediaIcon name="list-detail" size={90} className="canvas-text-try__icon" />
      <div className="canvas-text-try__actions">
        <span className="canvas-text-try__label">尝试：</span>
        <div className="canvas-text-try__list">
          {actions.map((action) => (
            <button key={action.label} type="button" className="canvas-text-try__item"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); action.run(); }}>
              <LibTVMediaIcon name={action.icon} size={14} />
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function scriptModelOptions(catalog: readonly ProviderCatalogEntry[]) {
  const entries = catalog.flatMap((provider) => provider.provider.enabled
    ? provider.models.filter(isTextGenerationModel).map((model) => ({ provider, model }))
    : []);
  const names = new Map<string, number>();
  for (const { model } of entries) names.set(model.displayName, (names.get(model.displayName) ?? 0) + 1);
  return entries.map(({ provider, model }) => ({
    value: `${provider.provider.id}::${model.definitionId}`,
    label: (names.get(model.displayName) ?? 0) > 1
      ? `${provider.provider.displayName} · ${model.displayName}` : model.displayName,
  }));
}

export function ScriptReferenceToolbar({ node, inputs, running, onPick, onRemove, onUnlink }: {
  readonly node: ScreenplayNodeData;
  readonly inputs: readonly { name: string; edgeId: string }[];
  readonly running: boolean;
  readonly onPick: (key: string) => void;
  readonly onRemove: (key: string, materialId: string) => void;
  readonly onUnlink: (edgeId: string) => void;
}) {
  return <>
    <button className="canvas-script-generator__reference-add" type="button" disabled={running}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onPick(node.key); }}>
      <LibTVMediaIcon name="plus-s" size={14} />参考图
    </button>
    {inputs.map((input) => (
      <span className="canvas-script-generator__reference" key={input.edgeId}>
        <span data-tooltip={input.name}>{input.name}</span>
        <button type="button" aria-label={`解除连线：${input.name}`} disabled={running}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onUnlink(input.edgeId); }}>
          <LibTVMediaIcon name="close" size={12} />
        </button>
      </span>
    ))}
    {(node.config.materials ?? []).map((material) => (
      <span className="canvas-script-generator__reference" key={material.id}>
        <span data-tooltip={material.displayName}>{material.displayName}</span>
        <button type="button" aria-label={`移除参考素材：${material.displayName}`} disabled={running}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onRemove(node.key, material.id); }}>
          <LibTVMediaIcon name="close" size={12} />
        </button>
      </span>
    ))}
  </>;
}

export function CanvasScriptEditor({ canvasId, node, active, running, batchRunning, error, providerCatalog, sourceInputs, connectedMedia,
  onUpdate, onRun, onPick, onPickAsset, onRemoveMaterial, onUnlink, onExport, onCreateMedia, onCreateAsset, onSmartCompose, onStartBatch, onResumeBatch,
  onFilm }: {
  readonly node: ScreenplayNodeData;
  readonly canvasId: string;
  readonly active: boolean;
  readonly running: boolean;
  /** 批量生成正在提交：只影响批量面板，不挡住分镜表格的编辑。 */
  readonly batchRunning?: boolean;
  readonly error: string | null;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly sourceInputs: readonly { key: string; name: string; edgeId: string; document: string }[];
  readonly connectedMedia: readonly { key: string; sourceKey: string; name: string; edgeId: string; kind: string }[];
  readonly onUpdate: ConfigUpdate;
  readonly onRun: (key: string) => void;
  readonly onPick: (key: string) => void;
  readonly onPickAsset: (key: string, assetId: string) => void;
  readonly onRemoveMaterial: (key: string, id: string) => void;
  readonly onUnlink: (edgeId: string) => void;
  readonly onExport: (key: string) => Promise<void>;
  readonly onCreateMedia: (key: string, shotId: string, kind: "image" | "video") => void;
  readonly onCreateAsset: (key: string, assetId: string) => void;
  readonly onSmartCompose: (key: string, shotIds: readonly string[]) => void;
  readonly onStartBatch: (key: string, request: ScriptBatchStartRequest) => void;
  readonly onResumeBatch: (key: string, batchId: string) => void;
  readonly onFilm?: (sources: readonly StoryboardFilmSource[]) => Promise<void>;
}) {
  const state = node.config.scriptGenerator;
  if (!state) return null;
  const updateState = (update: (current: ScriptGeneratorState) => ScriptGeneratorState) => {
    onUpdate((current) => {
      if (!current.scriptGenerator) return current;
      const next = update(current.scriptGenerator);
      return { ...current, scriptGenerator: next, currentDocument: scriptDocument(next) };
    });
  };
  const setStep = (step: ScriptStep) => updateState((current) => ({ ...current, step }));
  const updateShot = (id: string, field: ShotField, value: string) => updateState((current) => ({
    ...current, shots: current.shots.map((shot) => shot.id === id ? { ...shot, [field]: value } : shot),
  }));
  const moveShot = (id: string, distance: number) => updateState((current) => {
    const index = current.shots.findIndex((shot) => shot.id === id);
    const next = [...current.shots];
    const target = index + distance;
    if (index < 0 || target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return { ...current, shots: next };
  });
  const updateAsset = (id: string, patch: Partial<ScriptAsset>) => updateState((current) => ({
    ...current, assets: current.assets.map((asset) => asset.id === id ? { ...asset, ...patch } : asset),
  }));
  const options = scriptModelOptions(providerCatalog);
  const selectedModel = `${node.config.modelSelection.providerId}::${node.config.modelSelection.modelDefinitionId}`;
  const modelOptions = options.some((option) => option.value === selectedModel) ? options : [
    { value: selectedModel, label: node.config.modelSelection.modelDefinitionId || "请选择文本模型" }, ...options,
  ];
  const hasInput = Boolean(node.config.composer.trim() || sourceInputs.some((input) => input.document.trim()) ||
    connectedMedia.length || node.config.materials?.length);
  const canUndoReplacement = Boolean(state.previous && state.previous.afterFingerprint === scriptTableFingerprint(state.shots, state.assets));
  const needsBindingReview = (shot: ScriptShot) => Boolean(shot.unresolvedAssetRefs?.length ||
    (shot.assetIds ?? []).some((id) => !state.assets.some((asset) => asset.id === id)));
  const isComposable = (shot: ScriptShot) => canCompose(shot) && !needsBindingReview(shot);
  const pendingBindings = state.shots.filter(needsBindingReview).length;
  const compositionChunks = Math.ceil(state.shots.filter(isComposable).length / 20);
  const stepIndex = SCRIPT_STEPS.findIndex(([step]) => step === state.step);
  const previousStep = SCRIPT_STEPS[stepIndex - 1];
  const nextStep = SCRIPT_STEPS[stepIndex + 1];

  return (
    <div className="canvas-script-editor nodrag nowheel nopan">
      <nav className="canvas-script-editor__steps" aria-label="分镜制作步骤">
        {SCRIPT_STEPS.map(([step, label]) => <button type="button" key={step} aria-current={state.step === step ? "step" : undefined}
          onClick={() => setStep(step)}>{label}</button>)}
      </nav>
      {error ? <ErrorAlert error={error} hint="检查模型、输入和参考素材后再试。原有分镜会保留。" /> : null}
      <details className="canvas-script-editor__generation">
        <summary>生成设置与历史</summary>
        <div className="canvas-script-editor__generation-body">
          <div className="canvas-script-editor__settings">
            <CanvasSelect ariaLabel="脚本生成模型" value={selectedModel} options={modelOptions}
              chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
              selectedIcon={<LibTVMediaIcon name="check" size={12} />}
              disabled={running || !options.length} onChange={(value) => {
                const separator = value.indexOf("::");
                if (separator <= 0) return;
                onUpdate((current) => ({ ...current, modelSelection: {
                  providerId: value.slice(0, separator), modelDefinitionId: value.slice(separator + 2),
                } }));
              }} />
            <button type="button" disabled={running || !node.config.currentDocument.trim()}
              onClick={() => { void onExport(node.key); }}>导出 Markdown</button>
          </div>
          <div className="canvas-script-editor__references">
            <ScriptReferenceToolbar node={node} inputs={[...sourceInputs, ...connectedMedia]}
              running={running} onPick={onPick} onRemove={onRemoveMaterial} onUnlink={onUnlink} />
          </div>
          <label className="canvas-script-editor__request">生成要求
            <textarea value={node.config.composer} disabled={running}
              placeholder="描述剧情片段、故事，为你生成分镜脚本"
              onChange={(event) => {
                const value = event.currentTarget.value;
                onUpdate((current) => ({ ...current, composer: value }));
              }} />
          </label>
          <div className="canvas-script-editor__run">
            <span>{state.shots.length ? "再次生成会替换当前表格，可撤回上一次生成。" : "也可以直接添加镜头并手写。"}</span>
            <button type="button" disabled={running || !hasInput || !options.some((option) => option.value === selectedModel)}
              onClick={() => onRun(node.key)}>{running ? "正在生成…" : state.shots.length ? "重新生成分镜" : "生成分镜"}</button>
          </div>
          <ScriptHistoryRecovery canvasId={canvasId} nodeKey={node.key} running={running} onRestore={(detail) => {
            if (!detail.textOutput) throw new Error("所选任务没有文本结果。");
            const output = detail.textOutput.optimizedPrompt;
            onUpdate((current) => {
              if (!current.scriptGenerator) return current;
              const next = restoreScriptTaskOutput(current.scriptGenerator, detail.logicalRequest, output);
              return { ...current, scriptGenerator: next, currentDocument: scriptDocument(next) };
            });
          }} />
        </div>
      </details>
      {state.step === "prepare-assets" ? <section className="canvas-script-editor__section">
        <div className="canvas-script-editor__section-head"><strong>角色、场景和道具</strong><span>添加参考图后，在镜头行中明确关联资产。</span></div>
        {([ ["character", "角色"], ["scene", "场景"], ["prop", "道具"] ] as const).map(([kind, label]) => (
          <section className="canvas-script-editor__asset-group" key={kind}>
            <header>
              <strong>{label}</strong>
              <button type="button" disabled={running} onClick={() => updateState((current) => ({
                ...current, assets: [...current.assets, { id: crypto.randomUUID(), kind, name: "", description: "" }],
              }))}><LibTVMediaIcon name="plus-s" size={14} />添加{label}</button>
            </header>
            <div className="canvas-script-editor__asset-grid">
              {state.assets.filter((asset) => asset.kind === kind).map((asset) => (
                <div className="canvas-script-editor__asset" key={asset.id}>
                  <input aria-label={label + "名称"} placeholder={label + "名称"} value={asset.name} disabled={running}
                    onChange={(event) => updateAsset(asset.id, { name: event.target.value })} />
                  <textarea aria-label={`${asset.name || label}描述`} placeholder={label + "描述"} value={asset.description} disabled={running}
                    onChange={(event) => updateAsset(asset.id, { description: event.target.value })} />
                  {(() => {
                    const selected = asset.reference?.kind === "canvas" ? `node:${asset.reference.sourceKey}`
                      : asset.reference?.kind === "material" ? `material:${asset.reference.materialId}` : "";
                    const references = [
                      { value: "", label: "不关联参考图" },
                      ...connectedMedia.filter((input) => input.kind === "image").map((input) => ({
                        value: `node:${input.sourceKey}`, label: `画布：${input.name}`,
                      })),
                      ...(node.config.materials ?? []).filter((material) => material.kind === "image").map((material) => ({
                        value: `material:${material.id}`, label: `本地：${material.displayName}`,
                      })),
                    ];
                    if (selected && !references.some((option) => option.value === selected)) {
                      references.push({ value: selected, label: "参考图已断开，请重新选择" });
                    }
                    return <CanvasSelect ariaLabel={`${asset.name || "资产"}参考图`} value={selected} options={references}
                      disabled={running} onChange={(value) => updateAsset(asset.id, {
                        reference: value.startsWith("node:") ? { kind: "canvas", sourceKey: value.slice(5) }
                          : value.startsWith("material:") ? { kind: "material", materialId: value.slice(9) } : null,
                      })} />;
                  })()}
                  <div className="canvas-script-editor__actions">
                    <button type="button" disabled={running} onClick={() => onPickAsset(node.key, asset.id)}>
                      <LibTVMediaIcon name="plus-s" size={14} /> 选择参考图
                    </button>
                    <button type="button" disabled={running || !asset.description.trim()}
                      onClick={() => onCreateAsset(node.key, asset.id)}>创建资产图片节点</button>
                    <button type="button" disabled={running} onClick={() => updateState((current) => ({
                      ...current, assets: current.assets.filter((item) => item.id !== asset.id),
                    }))}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </section> : <section className="canvas-script-editor__section">
        <div className="canvas-script-editor__section-head"><strong>{state.step === "confirm-shots" ? "镜头列表" : "逐镜提示词"}</strong><span>{state.shots.length} 个镜头</span></div>
        {state.step === "compose-prompts" ? <p className="canvas-script-editor__stale">合成会替换当前提示词，可撤回上一次替换。智能合成调用所选文本模型，按供应商计费；全部合成将分 {compositionChunks || 0} 次请求。</p> : null}
        {state.step === "compose-prompts" && pendingBindings ? <p className="canvas-script-editor__stale">{pendingBindings} 个镜头的资产关联需要核对；批量合成会先跳过这些镜头。</p> : null}
        {state.step === "confirm-shots" ? <div className="canvas-script-editor__table-scroll" role="region" aria-label="镜头表，可横向滚动" tabIndex={0}>
          <table className="canvas-script-editor__table">
            <caption className="sr-only">可编辑的分镜镜头表</caption>
            <thead><tr><th scope="col">镜号</th>{SHOT_FIELDS.map(([, label]) => <th scope="col" key={label}>{label}</th>)}<th scope="col">关联资产</th><th scope="col">操作</th></tr></thead>
            <tbody>{state.shots.map((shot, index) => <tr key={shot.id}>
              <th scope="row">{index + 1}</th>
              {SHOT_FIELDS.map(([field, label]) => <td key={field}>
                <textarea aria-label={`镜头 ${index + 1} ${label}`} value={shot[field]} disabled={running}
                  onChange={(event) => updateShot(shot.id, field, event.target.value)} />
              </td>)}
              <td><ShotAssetBindings shot={shot} assets={state.assets} running={running} onChange={(ids, clearUnresolved) => updateState((current) => ({
                ...current, shots: current.shots.map((item) => item.id === shot.id ? { ...item, assetIds: ids, ...(clearUnresolved ? { unresolvedAssetRefs: [] } : {}) } : item),
              }))} /></td>
              <td><div className="canvas-script-editor__actions">
                <button type="button" aria-label={`镜头 ${index + 1} 上移`} disabled={running || index === 0} onClick={() => moveShot(shot.id, -1)}>上移</button>
                <button type="button" aria-label={`镜头 ${index + 1} 下移`} disabled={running || index === state.shots.length - 1} onClick={() => moveShot(shot.id, 1)}>下移</button>
                <button type="button" aria-label={`删除镜头 ${index + 1}`} disabled={running} onClick={() => updateState((current) => ({
                  ...current, shots: current.shots.filter((item) => item.id !== shot.id),
                }))}>删除</button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div> : state.shots.map((shot, index) => <article className="canvas-script-editor__shot" key={shot.id}>
          <div className="canvas-script-editor__shot-head"><strong>镜头 {index + 1}</strong>
            <div className="canvas-script-editor__actions">
              <button type="button" disabled={running || index === 0} onClick={() => moveShot(shot.id, -1)}>上移</button>
              <button type="button" disabled={running || index === state.shots.length - 1} onClick={() => moveShot(shot.id, 1)}>下移</button>
              <button type="button" disabled={running} onClick={() => updateState((current) => ({
                ...current, shots: current.shots.filter((item) => item.id !== shot.id),
              }))}>删除</button>
            </div>
          </div>
          <div className="canvas-script-editor__fields">
            {PROMPT_FIELDS.map(([field, label]) =>
              <label key={field}>{label}<textarea value={shot[field]} disabled={running}
                onChange={(event) => updateShot(shot.id, field, event.target.value)} /></label>)}
          </div>
          <ShotAssetBindings shot={shot} assets={state.assets} running={running} onChange={(ids, clearUnresolved) => updateState((current) => ({
            ...current, shots: current.shots.map((item) => item.id === shot.id ? { ...item, assetIds: ids, ...(clearUnresolved ? { unresolvedAssetRefs: [] } : {}) } : item),
          }))} />
          {state.step === "compose-prompts" && shot.composedFrom && shot.composedFrom !== scriptSourceSignature(shot, state.assets)
            ? <p className="canvas-script-editor__stale">镜头或资产描述已修改，请检查并重新合成提示词。</p> : null}
          {state.step === "compose-prompts" ? <div className="canvas-script-editor__actions">
            <button type="button" disabled={running || !isComposable(shot)} onClick={() => updateState((current) => ({
              ...replaceScriptTable(current, current.shots.map((item) => item.id === shot.id ? composeScriptShot(item, current.assets) : item)),
            }))}>自动拼接本镜提示词</button>
            <button type="button" disabled={running || !isComposable(shot) || !options.some((option) => option.value === selectedModel)}
              onClick={() => onSmartCompose(node.key, [shot.id])}>智能合成本镜</button>
            <button type="button" disabled={running || !shot.imagePrompt.trim()} onClick={() => onCreateMedia(node.key, shot.id, "image")}>创建图片节点</button>
            <button type="button" disabled={running || (!shot.videoPrompt.trim() && !shot.imageToVideoPrompt.trim())}
              onClick={() => onCreateMedia(node.key, shot.id, "video")}>创建视频节点</button>
          </div> : null}
        </article>)}
        <div className="canvas-script-editor__actions">
          <button type="button" disabled={running} onClick={() => updateState((current) => ({
            ...current, shots: [...current.shots, emptyScriptShot()],
          }))}>添加镜头</button>
          {state.step === "compose-prompts" ? <button type="button" disabled={running || !state.shots.some(isComposable)}
            onClick={() => updateState((current) => replaceScriptTable(current, current.shots.map((shot) =>
              canCompose(shot) && !(shot.assetIds ?? []).some((id) => !current.assets.some((asset) => asset.id === id))
                ? composeScriptShot(shot, current.assets) : shot)))}>自动拼接全部提示词</button> : null}
          {state.step === "compose-prompts" ? <button type="button" disabled={running || !state.shots.some(isComposable) || !options.some((option) => option.value === selectedModel)}
            onClick={() => onSmartCompose(node.key, state.shots.filter(isComposable).map((shot) => shot.id))}>智能合成全部提示词</button> : null}
          {state.previous ? <button type="button" disabled={running || !canUndoReplacement}
            data-tooltip={!canUndoReplacement ? "镜头或资产已继续编辑，不能用旧版本覆盖当前内容" : "撤回上一次生成或合成"}
            onClick={() => updateState((current) => {
            if (!current.previous || current.previous.afterFingerprint !== scriptTableFingerprint(current.shots, current.assets)) return current;
            const { previous, ...rest } = current;
            return { ...rest, shots: previous.shots, assets: previous.assets };
          })}>撤回上一次替换</button> : null}
        </div>
      </section>}
      <div className="canvas-script-editor__step-actions">
        {previousStep ? <button type="button" onClick={() => setStep(previousStep[0])}>上一步 · {previousStep[1]}</button> : <span />}
        {nextStep ? <button type="button" onClick={() => setStep(nextStep[0])}>下一步 · {nextStep[1]}</button> : null}
      </div>
      {state.step === "compose-prompts" || state.batches?.length ? <ScriptBatchPanel canvasId={canvasId} node={node} active={active} running={batchRunning ?? false} providerCatalog={providerCatalog}
        connectedMedia={connectedMedia} onUpdate={onUpdate} onStart={onStartBatch} onResume={onResumeBatch}
        {...(onFilm ? { onFilm } : {})} /> : null}
    </div>
  );
}
