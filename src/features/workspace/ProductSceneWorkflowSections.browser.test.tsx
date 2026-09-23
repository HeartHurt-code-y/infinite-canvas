import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
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
