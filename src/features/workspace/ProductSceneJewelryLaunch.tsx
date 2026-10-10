import { useEffect, useRef, useState } from "react";
import { ImeTextarea } from "../../components/ImeTextField";
import { formatRawBackendError, isDesktopRuntime } from "../../lib/backend";
import { saveMarkdownDocumentToDesktop } from "./desktopActions";
import {
  generateJewelryLaunchDraft,
  jewelryLaunchInputSignature,
  jewelryLaunchMarkdown,
  type JewelryLaunchDraft,
  type JewelryLaunchSlot,
} from "./jewelryLaunchPlan";
import type { ProductSceneWorkflowOptions } from "./productSceneWorkflowModel";
import { BrandDesignStudio, type BrandDesignCandidate } from "./BrandDesignStudio";
import { OptionalMark } from "./workflowFieldRequirements";
import "./ProductSceneJewelryLaunch.css";

interface ProductSceneJewelryLaunchProps {
  readonly options: ProductSceneWorkflowOptions;
  readonly disabled: boolean;
  readonly onChange: (options: ProductSceneWorkflowOptions) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly designCandidates?: readonly BrandDesignCandidate[];
}

const METHODS: Record<JewelryLaunchSlot["method"], string> = {
  source_layout: "原片直接设计",
  source_clean_white: "原片白底整理",
  missing_source: "先保留图位，待补适合的原图",
};
const FACT_STATUS = {
  input: "当前设置",
  merchant_provided: "商家资料",
  strategy: "策略建议",
  unknown: "需商家确认",
} as const;

function LaunchSlot({ slot }: { readonly slot: JewelryLaunchSlot }) {
  const hasCopy = Boolean(slot.copy.title || slot.copy.body);
  return (
    <details className="jewelry-launch__slot">
      <summary>
        <strong>
          {slot.id} · {slot.title}
        </strong>
        <span>来源：{slot.source?.label ?? "尚无适合的原图"}</span>
      </summary>
      <div className="jewelry-launch__slot-body">
        <p>{slot.purpose}</p>
        <p>制作方式：{METHODS[slot.method]}</p>
        {slot.sourceNotes.length > 0 && (
          <ul>
            {slot.sourceNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
        <div className="jewelry-launch__copy">
          <strong>图上文案{hasCopy ? "" : "：无"}</strong>
          {slot.copy.title && <p>{slot.copy.title}</p>}
          {slot.copy.body && <p>{slot.copy.body}</p>}
        </div>
        <details className="jewelry-launch__prompt">
          <summary>查看制作说明与 Prompt</summary>
          <p>{slot.prompt}</p>
          {slot.backgroundPrompt && (
            <>
              <strong>可选背景 Prompt</strong>
              <p>{slot.backgroundPrompt}</p>
            </>
          )}
        </details>
      </div>
    </details>
  );
}

function LaunchDraft({ draft }: { readonly draft: JewelryLaunchDraft }) {
  return (
    <div className="jewelry-launch__draft">
      <details className="jewelry-launch__section">
        <summary>产品变量与定位</summary>
        <dl className="jewelry-launch__variables">
          {draft.variables.map((variable) => (
            <div key={variable.key}>
              <dt>
                {variable.label} · {FACT_STATUS[variable.status]}
              </dt>
              <dd>{variable.value}</dd>
              <dd className="jewelry-launch__muted">依据：{variable.source}</dd>
            </div>
          ))}
        </dl>
        <p>
          <strong>产品定位：</strong>
          {draft.positioning}
        </p>
        <p>
          <strong>目标用户：</strong>
          {draft.audience}
        </p>
        <strong>卖点排序</strong>
        <ol>
          {draft.sellingPoints.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ol>
      </details>
      <div className="jewelry-launch__slots" aria-label="淘宝五张主图与五张详情规划">
        {draft.slots.map((slot) => (
          <LaunchSlot key={slot.id} slot={slot} />
        ))}
      </div>
      {draft.merchantConfirmations.length > 0 && (
        <details className="jewelry-launch__section">
          <summary>待补商品事实（{draft.merchantConfirmations.length} 项）</summary>
          <p>缺失事实先不写入宣传文案，现有方案仍可使用和导出。</p>
          <ul>
            {draft.merchantConfirmations.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="jewelry-launch__section">
        <summary>统一风格与质检清单</summary>
        <ul>
          {draft.styleRules.map((rule, index) => (
            <li key={index}>{rule}</li>
          ))}
        </ul>
        <strong>检查建议</strong>
        <ul>
          {draft.qualityChecks.map((check, index) => (
            <li key={index}>{check}</li>
          ))}
        </ul>
        {draft.notes.length > 0 && (
          <ul>
            {draft.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

export function ProductSceneJewelryLaunch({
  options,
  disabled,
  onChange,
  onBusyChange,
  designCandidates,
}: ProductSceneJewelryLaunchProps) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const launch = options.jewelry?.launch;
  const draft = launch?.draft;
  const stale = Boolean(draft && draft.inputSignature !== jewelryLaunchInputSignature(options));
  const latestOptions = useRef(options);
  useEffect(() => {
    latestOptions.current = options;
  }, [options]);

  function updateFacts(factsText: string) {
    if (!options.jewelry) return;
    onChange({
      ...options,
      jewelry: { ...options.jewelry, launch: { ...launch, factsText } },
    });
    setNotice(null);
  }

  function generateDraft() {
    if (!options.jewelry) return;
    try {
      const nextDraft = generateJewelryLaunchDraft(options);
      onChange({
        ...options,
        jewelry: { ...options.jewelry, launch: { ...launch, draft: nextDraft } },
      });
      setError(null);
      setNotice("淘宝十图方案已保存，可逐项查看或导出。");
    } catch (cause) {
      setError(`生成方案失败：${formatRawBackendError(cause)}`);
    }
  }

  async function exportDraft() {
    if (!draft || exporting) return;
    const content = `${stale ? "> 当前资料已改变，本文件保留上次生成的方案；可更新方案后再次导出。\n\n" : ""}${jewelryLaunchMarkdown(draft)}`;
    const name =
      Array.from(draft.productName, (character) => (character.charCodeAt(0) < 32 ? "_" : character))
        .join("")
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim()
        .slice(0, 80) || "珠宝商品";
    const fileName = `${name}-淘宝十图方案.md`;
    setExporting(true);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      if (isDesktopRuntime()) {
        const path = await saveMarkdownDocumentToDesktop(
          content,
          fileName,
          "淘宝十图 Markdown 方案",
        );
        if (!path) return;
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: "text/markdown;charset=utf-8" }),
        );
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          document.body.append(anchor);
          try {
            anchor.click();
          } finally {
            anchor.remove();
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      setNotice("淘宝十图方案已导出。");
    } catch (cause) {
      setError(`导出方案失败：${formatRawBackendError(cause)}`);
    } finally {
      setExporting(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="jewelry-launch nodrag nopan" aria-label="淘宝十图制作单">
      <strong>淘宝十图制作单</strong>
      <p>整理五张主图与五张详情的来源、文案和制作说明，再进入品牌图文设计，预览并导出实际成图。</p>
      <label>
        {/* 资料可以没有，方案照常生成：统一用共享的「（可选）」标注，不再手写括号。 */}
        <OptionalMark>现有商品资料</OptionalMark>
        <ImeTextarea
          value={launch?.factsText ?? ""}
          onValueChange={updateFacts}
          disabled={disabled || exporting}
          rows={4}
          placeholder="可粘贴已有商品卡。支持“材质：…”等字段及两列表格；未识别内容保留为资料。没有资料也能先做方案。"
        />
      </label>
      <div className="jewelry-launch__actions">
        <button type="button" disabled={disabled || exporting} onClick={generateDraft}>
          {draft ? "更新淘宝十图方案" : "生成淘宝十图方案"}
        </button>
        {draft && (
          <button type="button" disabled={exporting} onClick={() => void exportDraft()}>
            {exporting ? "正在导出…" : "导出十图方案"}
          </button>
        )}
      </div>
      {stale && (
        <p className="jewelry-launch__stale">
          资料或原图设置已改变，建议更新方案。旧方案仍可查看和导出。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {draft && <LaunchDraft draft={draft} />}
      {draft && (
        <BrandDesignStudio
          draft={draft}
          {...(launch?.design ? { design: launch.design } : {})}
          {...(designCandidates ? { candidates: designCandidates } : {})}
          disabled={disabled || exporting}
          {...(onBusyChange ? { onBusyChange } : {})}
          onChange={(design) => {
            const current = latestOptions.current;
            if (!current.jewelry) return;
            onChange({
              ...current,
              jewelry: { ...current.jewelry, launch: { ...current.jewelry.launch, design } },
            });
          }}
          onApplyAiStyle={(style, brief) => {
            const current = latestOptions.current;
            onChange({ ...current, brandCreative: { style, brief } });
            setNotice("品牌风格已用于 AI 场景图设置，下一次生成按新风格重新确认计划。");
          }}
        />
      )}
    </section>
  );
}
