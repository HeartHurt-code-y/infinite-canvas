import { Icon } from "../../components/Icon";
import { memo, useId } from "react";

const KNOWLEDGE_VIDEO_WORKFLOW_STAGES = ["智能策划", "自动生成", "质量检查", "成片交付"] as const;

export interface WorkflowRepositoryProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onInsertKnowledgeVideoWorkflow: () => void;
  readonly onInsertAiFilmWorkflow?: () => void;
  readonly onInsertComicDramaWorkflow?: () => void;
  readonly onInsertCommerceWorkflow?: () => void;
  readonly onInsertRemotionWorkflow?: () => void;
  readonly onInsertXhsCoverWorkflow?: () => void;
  readonly onInsertReverseVideoWorkflow?: () => void;
}

export const WorkflowRepository = memo(function WorkflowRepository({
  expanded,
  onToggle,
  onInsertKnowledgeVideoWorkflow,
  onInsertAiFilmWorkflow,
  onInsertComicDramaWorkflow,
  onInsertCommerceWorkflow,
  onInsertRemotionWorkflow,
  onInsertXhsCoverWorkflow,
  onInsertReverseVideoWorkflow,
}: WorkflowRepositoryProps) {
  const contentId = useId();
  const toggleLabelId = useId();

  return (
    <aside
      className={`workflow-repository${expanded ? " workflow-repository--expanded" : ""}`}
      aria-label="工作流仓库"
    >
      <button
        type="button"
        className="workflow-repository__toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="workflow-repository__toggle-mark" aria-hidden="true">
          <Icon name="stack-simple" size="xl" />
        </span>
        <span className="workflow-repository__toggle-copy">
          <span id={toggleLabelId} className="workflow-repository__title">
            工作流仓库
          </span>
          <span className="workflow-repository__summary">
            {expanded ? "收起模板" : "展开可复用模板"}
          </span>
        </span>
        <span className="workflow-repository__count">7 个自动工作流</span>
        <Icon
          name="caret-right"
          className="workflow-repository__toggle-icon"
          aria-hidden="true"
          size="lg"
        />
      </button>

      <div
        id={contentId}
        className="workflow-repository__content"
        role="region"
        aria-labelledby={toggleLabelId}
        hidden={!expanded}
      >
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">短视频反推工作流</h2>
            </div>
            <p className="workflow-repository__description">
              粘贴分享链接或选择本地视频，由项目下载器获取原片，自动抽帧、反推提示词与二创路线，校验后保存案例和交付文档。
            </p>
            <ol className="workflow-repository__stages" aria-label="短视频反推工作流能力">
              {["下载与抽帧", "反推与二创", "检查与入库", "文档交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertReverseVideoWorkflow}
            disabled={!onInsertReverseVideoWorkflow}
            aria-label="添加短视频反推工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加反推工作流
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="stack-simple" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">小红书封面工作流</h2>
            </div>
            <p className="workflow-repository__description">
              添加人物参考图和选题，自动提炼标题、匹配八种风格、生成与检查封面，交付 3:4
              竖版图片及提示词。
            </p>
            <ol className="workflow-repository__stages" aria-label="小红书封面工作流能力">
              {["标题与风格", "参考图生成", "自动检查", "封面交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertXhsCoverWorkflow}
            disabled={!onInsertXhsCoverWorkflow}
            aria-label="添加小红书封面工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加封面工作流
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>

          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">知识教学视频导演 V2.4</h2>
            </div>
            <p className="workflow-repository__description">
              画布只增加一个节点。全部模型只使用项目内已配置的供应商，一次执行自动产出完整交付物。
            </p>
            <ol className="workflow-repository__stages" aria-label="知识教学视频自动工作流能力">
              {KNOWLEDGE_VIDEO_WORKFLOW_STAGES.map((stage, index) => (
                <li key={stage} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="workflow-repository__stage-name">{stage}</span>
                </li>
              ))}
            </ol>
          </div>

          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertKnowledgeVideoWorkflow}
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加工作流节点
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">AI影视工作流 V1.3</h2>
            </div>
            <p className="workflow-repository__description">
              从故事概念到角色、剧本、资产、表演与视频，八个阶段自动衔接。支持已有资料接力和指定阶段修订。
            </p>
            <ol className="workflow-repository__stages" aria-label="AI影视工作流能力">
              {["故事与剧本", "角色与场景", "表演与镜头", "成片交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertAiFilmWorkflow}
            disabled={!onInsertAiFilmWorkflow}
            aria-label="添加AI影视工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加影视工作流
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">漫剧自动工作流</h2>
            </div>
            <p className="workflow-repository__description">
              导入分集剧本，自动完成导演分析、服化道设计和分镜编写。每步自动检查与修订，跨集复用角色、场景和道具。
            </p>
            <ol className="workflow-repository__stages" aria-label="漫剧自动工作流能力">
              {["导演分析", "服化道设计", "分镜编写", "自动交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertComicDramaWorkflow}
            disabled={!onInsertComicDramaWorkflow}
            aria-label="添加漫剧自动工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加漫剧工作流
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">剧情带货工作流</h2>
            </div>
            <p className="workflow-repository__description">
              添加商品资料与实物图，快速生成 15
              秒四镜头剧情，或完成五阶段制作。自动检查商品事实与包装一致性，交付文档和成片。
            </p>
            <ol className="workflow-repository__stages" aria-label="剧情带货工作流能力">
              {["商品研究", "剧情与剧本", "分镜与资产", "成片交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertCommerceWorkflow}
            disabled={!onInsertCommerceWorkflow}
            aria-label="添加剧情带货工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加带货工作流
          </button>
        </article>
        <article className="workflow-repository__card">
          <div className="workflow-repository__card-mark" aria-hidden="true">
            <Icon name="film-slate" size="2xl" />
          </div>
          <div className="workflow-repository__card-body">
            <div className="workflow-repository__card-heading">
              <span className="workflow-repository__badge">单节点</span>
              <h2 className="workflow-repository__card-title">动画逻辑图工作流</h2>
            </div>
            <p className="workflow-repository__description">
              输入描述或 ASCII 草图，自动匹配流程、卡片、时间线与数据图模板。在本机渲染 GIF 或
              MP4，并交付可编辑工程。
            </p>
            <ol className="workflow-repository__stages" aria-label="动画逻辑图工作流能力">
              {["理解内容", "匹配与检查", "本地渲染", "动画交付"].map((label) => (
                <li key={label} className="workflow-repository__stage">
                  <span className="workflow-repository__stage-name">{label}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            className="workflow-repository__insert"
            onClick={onInsertRemotionWorkflow}
            disabled={!onInsertRemotionWorkflow}
            aria-label="添加动画逻辑图工作流节点"
          >
            <Icon name="plus" aria-hidden="true" size="lg" />
            添加动画工作流
          </button>
        </article>
      </div>
    </aside>
  );
});
