import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import "../../App.css";
import "../../styles/studio.css";

function box(selector: string): DOMRect {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return element!.getBoundingClientRect();
}

function expectNoHorizontalOverflow() {
  const node = document.querySelector<HTMLElement>('[data-testid="workflow"]')!;
  expect(node.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
  for (const selector of [
    '[data-testid="workflow"]',
    ".canvas-knowledge-workflow__body",
    ".canvas-knowledge-workflow__inputs",
    ".canvas-knowledge-workflow__model-grid",
    ".canvas-knowledge-workflow__shots ol",
  ]) {
    const element = document.querySelector<HTMLElement>(selector)!;
    expect(element.scrollWidth, selector).toBeLessThanOrEqual(element.clientWidth + 1);
  }
}

describe("workflow node layout in a real browser", () => {
  it("uses horizontal space and returns to one column in a narrow viewport", async () => {
    await page.viewport(1200, 900);
    await render(
      <div className="react-flow__node">
        <article className="canvas-knowledge-workflow" data-testid="workflow">
          <header className="canvas-knowledge-workflow__header">知识视频工作流</header>
          <div className="canvas-knowledge-workflow__body">
            <div className="canvas-knowledge-workflow__inputs">
              <label className="canvas-knowledge-workflow__brief" data-testid="brief">
                <span>这次要制作什么？</span>
                <textarea defaultValue="横向布局中的制作要求" />
              </label>
              <section className="canvas-workflow-references" data-testid="references">
                <strong>参考素材</strong>
                <p>一份用于规划的参考资料</p>
                <button type="button">添加参考素材</button>
              </section>
            </div>
            <details className="canvas-knowledge-workflow__models" open>
              <summary>模型配置</summary>
              <div className="canvas-knowledge-workflow__model-grid">
                {["策划与审核", "图片生成", "视频生成"].map((name) => (
                  <fieldset className="canvas-knowledge-workflow__model-slot" key={name}>
                    <legend>{name}</legend>
                    <label>
                      <span>项目模型</span>
                      <select aria-label={`${name}模型`} defaultValue="model">
                        <option value="model">已启用模型</option>
                      </select>
                    </label>
                  </fieldset>
                ))}
              </div>
            </details>
            <section className="canvas-knowledge-workflow__shots">
              <h4>分镜视频</h4>
              <ol>
                <li data-testid="shot-one">镜头一</li>
                <li data-testid="shot-two">镜头二</li>
                <li data-testid="shot-editing">
                  镜头三
                  <div className="canvas-knowledge-workflow__shot-editor">
                    <label>
                      修改镜头提示词
                      <textarea defaultValue="新的镜头要求" />
                    </label>
                  </div>
                </li>
                <li data-testid="shot-four">镜头四</li>
              </ol>
            </section>
          </div>
        </article>
      </div>,
    );
    await expect.element(page.getByTestId("workflow")).toBeVisible();

    expectNoHorizontalOverflow();
    expect(box('[data-testid="references"]').top).toBe(box('[data-testid="brief"]').top);
    const models = document.querySelectorAll<HTMLElement>(".canvas-knowledge-workflow__model-slot");
    expect(models).toHaveLength(3);
    expect(models[0]!.getBoundingClientRect().top).toBe(models[1]!.getBoundingClientRect().top);
    expect(models[1]!.getBoundingClientRect().top).toBe(models[2]!.getBoundingClientRect().top);
    expect(box('[data-testid="shot-one"]').top).toBe(box('[data-testid="shot-two"]').top);
    const shotGrid = box(".canvas-knowledge-workflow__shots ol");
    const editingShot = box('[data-testid="shot-editing"]');
    expect(editingShot.left).toBeCloseTo(shotGrid.left, 0);
    expect(editingShot.right).toBeCloseTo(shotGrid.right, 0);

    await page.viewport(660, 900);
    expectNoHorizontalOverflow();
    expect(box('[data-testid="workflow"]').width).toBeCloseTo(628, 0);

    await page.viewport(480, 900);
    expectNoHorizontalOverflow();
    expect(box('[data-testid="references"]').top).toBeGreaterThan(box('[data-testid="brief"]').top);
    expect(models[1]!.getBoundingClientRect().top).toBeGreaterThan(
      models[0]!.getBoundingClientRect().top,
    );
    expect(box('[data-testid="shot-two"]').top).toBeGreaterThan(
      box('[data-testid="shot-one"]').top,
    );
  });
});
