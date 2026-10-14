import { useCallback, useId, type ReactNode } from "react";

import { Icon } from "../../components/Icon";
import { WORKFLOW_GUIDES, type WorkflowGuideKind } from "./workflowGuidanceContent";
import "./WorkflowGuidance.css";

/**
 * 就地解释参数。放在 label 内的控件之后（或由 label[htmlFor] 指向外部控件），
 * 保持标签名称简短：说明通过 aria-describedby 成为控件的描述，而不是名称的一部分。
 *
 * 关联不依赖调用方的渲染方式：挂载时建立一次关联，之后由 label 子树上的
 * MutationObserver 自愈。React 因报错出现/消失重写控件的 aria-describedby、
 * 或控件在后续提交里才挂载时，本 id 会在一个微任务内补回；id 已在时绝不重写，
 * 因此不会和 React 或同一 label 里的多份说明形成写循环。把字段包进 React.memo、
 * 拆进子组件都不会丢失关联，读屏最终总能读到「错误描述 + 参数说明」。
 *
 * 约束（属于 interface 的一部分）：控件必须是 label 的 DOM 后代或
 * label[htmlFor] 指向的元素；Portal 到 label 之外的控件不关联。
 * 已有错误描述保留，朗读顺序为「先错误、后说明」。
 */
export function WorkflowFieldHelp({ children }: { readonly children: ReactNode }) {
  const id = useId();
  // ref 必须稳定：React 只在挂载时执行一次，之后的关联全靠观察者自愈，
  // 不再像内联 ref 那样每次 commit 重新扫描、把正确性押在调用方不 memo 上。
  const associate = useCallback(
    (element: HTMLElement | null) => {
      if (element == null) return;
      const label = element.closest("label");
      if (label == null) {
        // 无 label 可关联：保持可见，作为普通正文朗读。
        element.removeAttribute("aria-hidden");
        return () => {};
      }
      // 标签内的说明文字会进入控件的可访问名称，先按展示隐藏，再用描述补回。
      element.setAttribute("aria-hidden", "true");
      const controls = () => {
        const found = new Set<HTMLElement>(label.querySelectorAll("input, textarea, select"));
        if (label.control instanceof HTMLElement) found.add(label.control);
        return found;
      };
      const apply = () => {
        for (const control of controls()) {
          const current = control.getAttribute("aria-describedby") ?? "";
          if (current.split(/\s+/).includes(id)) continue;
          const ids = [...current.split(/\s+/).filter(Boolean), id];
          control.setAttribute("aria-describedby", ids.join(" "));
        }
      };
      apply();
      const observer = new MutationObserver(apply);
      observer.observe(label, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-describedby"],
      });
      return () => {
        observer.disconnect();
        for (const control of controls()) {
          const ids = (control.getAttribute("aria-describedby") ?? "")
            .split(/\s+/)
            .filter((value) => value && value !== id);
          if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
          else control.removeAttribute("aria-describedby");
        }
      };
    },
    [id],
  );
  return (
    <small id={id} className="workflow-field-help" ref={associate}>
      {children}
    </small>
  );
}

export function WorkflowGuide({ kind }: { readonly kind: WorkflowGuideKind }) {
  const guide = WORKFLOW_GUIDES[kind];
  return (
    <section className="workflow-guide" aria-label="工作流使用指南">
      <p className="workflow-guide__purpose">{guide.purpose}</p>
      <details>
        <summary>
          <Icon name="book-open-text" aria-hidden="true" size="md" />
          第一次使用？查看准备步骤与填写示例
          <Icon name="caret-down" aria-hidden="true" size="sm" />
        </summary>
        <div className="workflow-guide__content">
          <div>
            <strong>先准备这些</strong>
            <p>{guide.prepare}</p>
            <strong>按这个顺序操作</strong>
            <ol>
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          <div>
            <strong>制作要求可以这样写</strong>
            <blockquote>{guide.example}</blockquote>
            <p>
              把示例中的主题、受众和风格换成自己的需求。带红色 *
              的项目必须补齐；其余设置可先保留当前值，再按下面的说明调整。
            </p>
            <p>
              先查看执行计划，再确认执行。模型调用可能产生费用，数量和返工会增加调用次数；修改输入后应重新查看计划。
            </p>
          </div>
          {guide.demo ? (
            <div>
              <strong>照着填一遍（逐个参数的实操演示）</strong>
              <p>从上到下就是界面的字段顺序：填什么、界面和成图会因此发生什么。</p>
              <table className="workflow-guide__demo">
                <thead>
                  <tr>
                    <th scope="col">参数</th>
                    <th scope="col">这样填</th>
                    <th scope="col">效果</th>
                  </tr>
                </thead>
                <tbody>
                  {guide.demo.map((row) => (
                    <tr key={row.field}>
                      <th scope="row">{row.field}</th>
                      <td>{row.fill}</td>
                      <td>{row.effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}

export function WorkflowPreparation({ kind }: { readonly kind: WorkflowGuideKind }) {
  return (
    <p className="workflow-preparation">
      <strong>先准备：</strong>
      {WORKFLOW_GUIDES[kind].prepare}
    </p>
  );
}
