import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { ProductSceneProtectionEditor } from "./ProductSceneProtectionEditor";
import "../../App.css";
import "./ProductSceneWorkflowSections.css";

const filenames = ["微信图片_20260910144244_85_401.png", "2f20cbf09b2a760346b6b49ffa2f38a1.webp"];

function assertNoHorizontalOverflow(container: HTMLElement) {
  const containerRight = container.getBoundingClientRect().right;
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
  for (const card of container.querySelectorAll<HTMLElement>(".product-scene__view")) {
    const cardRight = card.getBoundingClientRect().right;
    expect(cardRight).toBeLessThanOrEqual(containerRight + 1);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    for (const child of card.children) {
      expect(child.getBoundingClientRect().right).toBeLessThanOrEqual(cardRight + 1);
    }
  }
}

describe("product scene reference cards in a narrow canvas node", () => {
  it("keeps the protection editor usable at narrow and wide node sizes with pointer and keyboard input", async () => {
    const save = vi.fn();
    const image =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="silver"/></svg>',
      );
    await render(
      <div data-testid="protection-node" style={{ width: 375 }}>
        <fieldset className="product-scene__configuration">
          <article className="product-scene__view">
            <ProductSceneProtectionEditor
              view={{
                id: "source",
                label: "天然水晶手串真实佩戴母版.png",
                angle: "front45",
                sourcePath: image,
                preparedPath: image,
                contentHash: "a".repeat(64),
                width: 300,
                height: 200,
                approved: true,
                protection: {
                  rect: { x: 0, y: 0, width: 1, height: 1 },
                  feather: 0.025,
                  use: "wearing",
                },
              }}
              onSave={save}
              onCancel={vi.fn()}
            />
          </article>
        </fieldset>
      </div>,
    );
    const node = page.getByTestId("protection-node").element() as HTMLElement;
    await expect
      .element(page.getByRole("img", { name: "天然水晶手串真实佩戴母版.png 完整实拍母版" }))
      .toBeVisible();
    for (const width of [375, 720]) {
      node.style.width = `${width}px`;
      expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
      for (const control of node.querySelectorAll<HTMLElement>("input, select, button")) {
        expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(
          node.getBoundingClientRect().right + 1,
        );
      }
    }
    const widthField = page.getByRole("spinbutton", {
      name: "天然水晶手串真实佩戴母版.png 保护宽度百分比",
    });
    const canvas = node.querySelector<HTMLElement>(".product-scene-protection__canvas")!;
    const bounds = canvas.getBoundingClientRect();
    await userEvent.dragAndDrop(canvas, canvas, {
      sourcePosition: { x: bounds.width * 0.2, y: bounds.height * 0.15 },
      targetPosition: { x: bounds.width * 0.8, y: bounds.height * 0.85 },
    });
    expect(Number((widthField.element() as HTMLInputElement).value)).toBeCloseTo(60, 0);
    expect(save).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "重置为整张原片" }).click();
    await widthField.fill("75");
    await expect.element(widthField).toHaveValue(75);
    expect(save).not.toHaveBeenCalled();
    (page.getByRole("button", { name: "应用保护范围" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(save).toHaveBeenCalledWith({
      rect: { x: 0, y: 0, width: 0.75, height: 1 },
      feather: 0.025,
      use: "wearing",
    });
  });
  it("keeps long names and controls inside cards, then uses two columns when space permits", async () => {
    await render(
      <div data-testid="node" style={{ width: 420 }}>
        <fieldset className="product-scene__configuration">
          <div className="product-scene__views" data-testid="views">
            {filenames.map((filename) => (
              <article className="product-scene__view" key={filename}>
                <button className="product-scene__preview" type="button">
                  <img
                    alt="产品参考"
                    src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
                  />
                </button>
                <strong>{filename}</strong>
                <small>2687 × 850</small>
                <label>
                  参考图原始角度（与目标机位独立）
                  <select aria-label={`${filename} 角度`}>
                    <option>正面45°</option>
                  </select>
                </label>
                <label className="product-scene__approval">
                  <input type="checkbox" />
                  确认同一产品版本，原始角度标注正确，边缘 / Logo / 接口完整
                </label>
                <button type="button">移除 {filename}</button>
              </article>
            ))}
          </div>
        </fieldset>
      </div>,
    );
    await expect.element(page.getByTestId("views")).toBeInTheDocument();
    const node = document.querySelector<HTMLElement>('[data-testid="node"]')!;
    const views = document.querySelector<HTMLElement>('[data-testid="views"]')!;
    assertNoHorizontalOverflow(views);
    const cards = views.querySelectorAll<HTMLElement>(".product-scene__view");
    expect(cards[1]!.getBoundingClientRect().top).toBeGreaterThan(
      cards[0]!.getBoundingClientRect().top,
    );
    node.style.width = "720px";
    assertNoHorizontalOverflow(views);
    expect(cards[1]!.getBoundingClientRect().top).toBe(cards[0]!.getBoundingClientRect().top);
  });
});
