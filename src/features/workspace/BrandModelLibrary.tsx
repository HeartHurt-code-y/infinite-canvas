import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { toMediaSrc } from "../../lib/backend";
import {
  approveBrandModelVersion,
  archiveBrandModel,
  brandModelVersionRequirements,
  listBrandModels,
  saveBrandModelVersion,
  selectBrandModelVersion,
  validateBrandModelVersion,
  type BrandModelProfile,
  type BrandModelSelection,
} from "../../lib/brandModels";
import { RequiredMark, WorkflowRequirementsHint } from "./workflowFieldRequirements";
import "./BrandModelLibrary.css";

export interface BrandModelCandidate {
  readonly path: string;
  readonly label: string;
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}

type ReferenceRole = "front" | "profile" | "three_quarter" | "full_body" | "expression" | "detail";
interface EditableReference extends Omit<BrandModelCandidate, "path"> {
  readonly sourcePath: string;
  readonly role: ReferenceRole;
}

const ROLES: readonly { readonly id: ReferenceRole; readonly label: string }[] = [
  { id: "front", label: "正面" },
  { id: "profile", label: "侧面" },
  { id: "three_quarter", label: "四分之三侧面" },
  { id: "full_body", label: "全身" },
  { id: "expression", label: "表情" },
  { id: "detail", label: "特征细节" },
];

export interface BrandModelLibraryProps {
  readonly selected?: BrandModelSelection;
  readonly disabled: boolean;
  readonly onSelect: (selection: BrandModelSelection | undefined) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly candidates?: readonly BrandModelCandidate[];
  readonly brandName?: string;
}

export function BrandModelLibrary({
  selected,
  disabled,
  onSelect,
  onBusyChange,
  candidates = [],
  brandName = "",
}: BrandModelLibraryProps) {
  const errorId = useId();
  const [profiles, setProfiles] = useState<readonly BrandModelProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [brand, setBrand] = useState(brandName);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [invariants, setInvariants] = useState("");
  const [references, setReferences] = useState<readonly EditableReference[]>([]);
  const [candidatePath, setCandidatePath] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const operation = useRef(false);
  const loaded = useRef(false);
  const loadingOperation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function loadProfiles() {
    if (loadingOperation.current) return;
    loadingOperation.current = true;
    setLoading(true);
    setError(null);
    try {
      const items = await listBrandModels();
      if (!mounted.current) return;
      setProfiles(items);
      loaded.current = true;
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      loadingOperation.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  const profile = profiles.find((item) => item.id === profileId);
  const version = profile?.versions.find((item) => item.id === versionId);
  const locked = disabled || busy || loading;
  const describedBy = error ? errorId : undefined;
  const versionInput = {
    ...(profile
      ? { profileId: profile.id, expectedCurrentVersionId: profile.currentVersionId }
      : {}),
    brandName: brand.trim(),
    name: name.trim(),
    description,
    invariants,
    references,
  };
  const requirements = brandModelVersionRequirements(versionInput);
  const requirementLabels = {
    brandName: "品牌名称",
    name: "模特名称",
    description: "人物描述",
    invariants: "固定特征",
    references: "人物参考照片",
  };
  const hasEdits =
    version != null &&
    profile != null &&
    (brand !== profile.brandName ||
      name !== profile.name ||
      description !== version.description ||
      invariants !== version.invariants ||
      references.length !== version.references.length ||
      references.some((item, index) => {
        const saved = version.references[index];
        return (
          saved == null ||
          item.sourcePath !== saved.path ||
          item.label !== saved.label ||
          item.role !== saved.role
        );
      }));

  function loadVersion(nextProfile: BrandModelProfile | undefined, nextVersionId?: string) {
    setError(null);
    setNotice("");
    setProfileId(nextProfile?.id ?? "");
    const nextVersion =
      nextProfile?.versions.find((item) => item.id === nextVersionId) ??
      nextProfile?.versions.at(-1);
    setVersionId(nextVersion?.id ?? "");
    setBrand(nextProfile?.brandName ?? brandName);
    setName(nextProfile?.name ?? "");
    setDescription(nextVersion?.description ?? "");
    setInvariants(nextVersion?.invariants ?? "");
    setReferences(
      nextVersion?.references.map((item) => ({
        sourcePath: item.path,
        label: item.label,
        role: item.role,
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.resultIndex != null ? { resultIndex: item.resultIndex } : {}),
        ...(item.sourceNodeId ? { sourceNodeId: item.sourceNodeId } : {}),
      })) ?? [],
    );
  }

  function receive(nextProfile: BrandModelProfile, nextVersionId?: string) {
    setProfiles((items) => [...items.filter((item) => item.id !== nextProfile.id), nextProfile]);
    loadVersion(nextProfile, nextVersionId);
  }

  async function work(action: () => Promise<void>) {
    if (disabled || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    onBusyChange?.(true);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange?.(false);
    }
  }

  function importReferences() {
    void work(async () => {
      const result = await open({
        multiple: true,
        title: "添加数字模特参考图",
        filters: [{ name: "人物图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!result || !mounted.current) return;
      const paths = Array.isArray(result) ? result : [result];
      setReferences((items) => {
        const seen = new Set(items.map((item) => item.sourcePath));
        return [
          ...items,
          ...paths
            .filter((path) => !seen.has(path))
            .map((sourcePath) => ({
              sourcePath,
              label: sourcePath.split(/[\\/]/).at(-1) ?? sourcePath,
              role: "front" as const,
            })),
        ];
      });
    });
  }

  function saveVersion() {
    void work(async () => {
      if (requirements.length) {
        throw new Error(requirements.map((requirement) => requirement.hint).join(" "));
      }
      const saved = await saveBrandModelVersion(versionInput);
      if (!mounted.current) return;
      receive(saved);
      setNotice(
        "已保存新草稿版本，参考照片已托管到本机模特库。检查照片与特征后批准，才可用于新任务。",
      );
    });
  }

  function approveVersion() {
    if (!profile || !version) return;
    void work(async () => {
      const approved = await approveBrandModelVersion({
        profileId: profile.id,
        versionId: version.id,
        expectedSignature: version.signature,
      });
      if (!mounted.current) return;
      receive(approved, version.id);
      setNotice("该版本已批准。使用时会固定版本与照片摘要，后续新版本不会替换已有任务的参考。");
    });
  }

  function toggleArchive() {
    if (!profile) return;
    void work(async () => {
      const updated = await archiveBrandModel({
        profileId: profile.id,
        archived: !profile.archived,
      });
      if (!mounted.current) return;
      receive(updated, versionId);
      setNotice(
        updated.archived
          ? "模特已归档。已有任务保留原版本；新任务不能选用归档模特。"
          : "模特已恢复，可继续管理和选用已批准版本。",
      );
    });
  }

  return (
    <details
      className="brand-model-library"
      aria-label="品牌数字模特库"
      aria-busy={busy || loading}
      onToggle={(event) => {
        if (!event.currentTarget.open) return;
        if (!profileId && !brand.trim()) setBrand(brandName);
        if (!loaded.current) void loadProfiles();
      }}
    >
      <summary>
        <strong>品牌数字模特库</strong>
        <span>{selected ? "已固定模特版本" : "管理人物参考与版本"}</span>
      </summary>
      <div className="brand-model-library__body">
        <p>
          同一模特在不同画布中复用。本机托管参考照片和不可变版本，用于图片与视频生成的人物一致性；保存档案不会训练模型。
        </p>
        {selected ? (
          <div className="brand-model-library__selection" role="status">
            <strong>当前任务：{selected.name} · 已固定版本</strong>
            <small>修改档案不会替换此任务中的人物参考。</small>
            <button type="button" disabled={locked} onClick={() => onSelect(undefined)}>
              移除当前任务的模特
            </button>
          </div>
        ) : null}
        <div className="brand-model-library__actions">
          <button
            type="button"
            disabled={locked}
            aria-describedby={describedBy}
            onClick={() => loadVersion(undefined)}
          >
            新建模特
          </button>
          <button
            type="button"
            disabled={disabled || busy || loading}
            aria-describedby={describedBy}
            onClick={() => void loadProfiles()}
          >
            刷新模特库
          </button>
        </div>
        <fieldset disabled={locked} className="brand-model-library__fields">
          <label>
            <span>模特档案</span>
            <select
              aria-label="模特档案"
              value={profileId}
              onChange={(event) =>
                loadVersion(profiles.find((item) => item.id === event.target.value))
              }
            >
              <option value="">新建模特</option>
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.brandName} / {item.name}
                  {item.archived ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </label>
          {profile ? (
            <label>
              <span>查看版本</span>
              <select
                aria-label="模特版本"
                value={versionId}
                onChange={(event) => loadVersion(profile, event.target.value)}
              >
                {profile.versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    V{item.version} · {item.status === "approved" ? "已批准" : "草稿"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <RequiredMark>品牌名称</RequiredMark>
            <ImeInput
              aria-label="模特所属品牌"
              value={brand}
              onValueChange={setBrand}
              aria-describedby={describedBy}
              placeholder="例如：杉间"
            />
          </label>
          <label>
            <RequiredMark>模特名称</RequiredMark>
            <ImeInput
              aria-label="数字模特名称"
              value={name}
              onValueChange={setName}
              aria-describedby={describedBy}
              placeholder="用于区分品牌模特"
            />
          </label>
          <label>
            <RequiredMark>人物描述</RequiredMark>
            <ImeTextarea
              aria-label="数字模特人物描述"
              rows={3}
              value={description}
              onValueChange={setDescription}
              aria-describedby={describedBy}
              placeholder="年龄为成年人、气质、发型和整体形象"
            />
          </label>
          <label>
            <RequiredMark>固定特征</RequiredMark>
            <ImeTextarea
              aria-label="数字模特固定特征"
              rows={3}
              value={invariants}
              onValueChange={setInvariants}
              aria-describedby={describedBy}
              placeholder="跨图、跨镜头必须保持的脸型、眼睛、发色等特征"
            />
          </label>
          <section aria-label="模特参考照片" className="brand-model-library__references">
            <strong>
              <RequiredMark>人物参考照片</RequiredMark>
            </strong>
            <button type="button" aria-describedby={describedBy} onClick={importReferences}>
              添加人物图片
            </button>
            {candidates.length ? (
              <div className="brand-model-library__candidate">
                <label>
                  <span>使用已保存的 AI 成图</span>
                  <select
                    aria-label="选择已保存的模特成图"
                    value={candidatePath}
                    onChange={(event) => setCandidatePath(event.target.value)}
                  >
                    <option value="">选择人物成图</option>
                    {candidates.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!candidatePath}
                  onClick={() => {
                    const candidate = candidates.find((item) => item.path === candidatePath);
                    if (!candidate) return;
                    setReferences((items) =>
                      items.some((item) => item.sourcePath === candidate.path)
                        ? items
                        : [
                            ...items,
                            {
                              sourcePath: candidate.path,
                              label: candidate.label,
                              role: "front",
                              ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
                              ...(candidate.resultIndex != null
                                ? { resultIndex: candidate.resultIndex }
                                : {}),
                              ...(candidate.sourceNodeId
                                ? { sourceNodeId: candidate.sourceNodeId }
                                : {}),
                            },
                          ],
                    );
                  }}
                >
                  加入参考照片
                </button>
              </div>
            ) : null}
            {references.length === 0 ? (
              <p>添加同一成年模特的清晰正面、侧面或全身照片。没有照片时不能建立可复用身份。</p>
            ) : (
              <ul>
                {references.map((item, index) => (
                  <li key={`${index}:${item.sourcePath}`}>
                    <img src={toMediaSrc(item.sourcePath)} alt={`${item.label} 人物参考`} />
                    <div className="brand-model-library__reference-fields">
                      <label>
                        <span>参考名称</span>
                        <ImeInput
                          aria-label={`人物参考名称 ${index + 1}`}
                          value={item.label}
                          onValueChange={(label) =>
                            setReferences((items) =>
                              items.map((ref, position) =>
                                position === index ? { ...ref, label } : ref,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>照片用途</span>
                        <select
                          aria-label={`人物参考用途 ${index + 1}`}
                          value={item.role}
                          onChange={(event) =>
                            setReferences((items) =>
                              items.map((ref, position) =>
                                position === index
                                  ? { ...ref, role: event.target.value as ReferenceRole }
                                  : ref,
                              ),
                            )
                          }
                        >
                          {ROLES.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {item.taskId ? <small>已保留 AI 成图来源</small> : null}
                      <button
                        type="button"
                        aria-label={`移除人物参考 ${index + 1}`}
                        onClick={() =>
                          setReferences((items) =>
                            items.filter((_, position) => position !== index),
                          )
                        }
                      >
                        移除照片
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="brand-model-library__actions">
            <button
              type="button"
              aria-describedby={describedBy}
              disabled={profile?.archived === true || requirements.length > 0}
              onClick={saveVersion}
            >
              {profile ? "保存为新版本" : "保存模特草稿"}
            </button>
            {profile && version ? (
              <>
                <button
                  type="button"
                  aria-describedby={describedBy}
                  disabled={profile.archived || version.status === "approved" || hasEdits}
                  onClick={approveVersion}
                >
                  批准当前版本
                </button>
                <button
                  type="button"
                  aria-describedby={describedBy}
                  disabled={profile.archived || version.status !== "approved" || hasEdits}
                  onClick={() =>
                    void work(async () => {
                      const checked = await validateBrandModelVersion({
                        profileId: profile.id,
                        versionId: version.id,
                        expectedSignature: version.signature,
                      });
                      if (!mounted.current) return;
                      onSelect(selectBrandModelVersion(profile, checked));
                      setNotice("当前任务已固定此模特版本。更换或移除后，需要重新确认制作计划。");
                    })
                  }
                >
                  使用当前版本
                </button>
                <button type="button" aria-describedby={describedBy} onClick={toggleArchive}>
                  {profile.archived ? "恢复模特" : "归档模特"}
                </button>
              </>
            ) : null}
          </div>
          {hasEdits ? <p>这些编辑尚未保存。保存为新版本并批准后，才能选用编辑后的模特。</p> : null}
        </fieldset>
        <WorkflowRequirementsHint
          requirements={requirements.map((requirement) => ({
            field: requirementLabels[requirement.field],
            hint: requirement.hint,
          }))}
        />
        {notice ? (
          <p className="brand-model-library__notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <ErrorAlert
            id={errorId}
            error={error}
            hint="补齐品牌、模特名称、人物描述、固定特征和参考照片；文件不可读时换一张清晰图片，库更新冲突时先刷新再保存。"
          />
        ) : null}
      </div>
    </details>
  );
}
