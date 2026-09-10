// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("画布素材节点尺寸", () => {
  it("为拖入的素材保留大尺寸媒体预览区", () => {
    expect(cssRule(".canvas-asset-node")).toMatch(/width:\s*500px/);
    expect(cssRule(".canvas-asset-node")).toMatch(/height:\s*437\.5px/);
    expect(
      cssRule(".canvas-asset-node:not(.canvas-asset-node--media) .canvas-asset-node__visual"),
    ).toMatch(/min-height:\s*362\.5px/);
  });

  it("任务启动后自动生成的产物卡片与普通素材节点同为正常尺寸", () => {
    expect(cssRule(".canvas-asset-node--output")).toMatch(/width:\s*500px/);
    expect(cssRule(".canvas-asset-node--output")).toMatch(/height:\s*437\.5px/);
  });

  it("让图片和视频完整全出血展示且不裁切", () => {
    expect(cssRule(".canvas-asset-node--media")).toMatch(/padding:\s*0/);
    expect(cssRule(".canvas-asset-node--media")).toMatch(/overflow:\s*visible/);
    expect(cssRule(".canvas-asset-node--media > .canvas-asset-node__visual")).toMatch(
      /position:\s*absolute/,
    );
    expect(cssRule(".canvas-asset-node--media > .canvas-asset-node__visual")).toMatch(/inset:\s*0/);
    expect(cssRule(".canvas-asset-node--media > .canvas-asset-node__visual")).toMatch(
      /min-height:\s*0/,
    );
    expect(cssRule(".canvas-asset-node--media > .canvas-asset-node__visual")).toMatch(
      /overflow:\s*hidden/,
    );
    expect(cssRule(".canvas-asset-node__visual img")).toMatch(/object-fit:\s*contain/);
    expect(cssRule(".canvas-asset-node__visual video")).toMatch(/object-fit:\s*contain/);
  });

  it("只裁切媒体圆角，不裁掉伸出卡片的连接端口", () => {
    expect(cssRule(".canvas-asset-node--media")).toMatch(/overflow:\s*visible/);
    expect(cssRule(".canvas-asset-node__port")).toMatch(/right:\s*-12px/);
    expect(cssRule(".canvas-asset-node__port")).toMatch(/width:\s*24px/);
    expect(cssRule(".canvas-asset-node__port")).toMatch(/height:\s*24px/);
    expect(cssRule(".canvas-asset-node__port::after")).toMatch(/width:\s*var\(--space-md\)/);
  });
});

describe("画布生成节点尺寸", () => {
  it("保留基础尺寸并允许图片与视频生成节点随连接素材数量向下延展", () => {
    expect(cssRule(".canvas-gen-node--image")).toMatch(/width:\s*580px/);
    expect(cssRule(".canvas-gen-node--image")).toMatch(/height:\s*auto/);
    expect(cssRule(".canvas-gen-node--image")).toMatch(/min-height:\s*480px/);
    expect(cssRule(".canvas-gen-node--video")).toMatch(/width:\s*580px/);
    expect(cssRule(".canvas-gen-node--video")).toMatch(/height:\s*auto/);
    expect(cssRule(".canvas-gen-node--video")).toMatch(/min-height:\s*900px/);
    expect(cssRule(".canvas-gen-node .node-media-inputs")).toMatch(/max-height:\s*none/);
    expect(cssRule(".canvas-gen-node .node-media-inputs")).toMatch(/overflow:\s*visible/);
    expect(cssRule(".canvas-gen-node--video .canvas-gen-node__settings")).toMatch(
      /max-height:\s*none/,
    );
    expect(cssRule(".canvas-gen-node--video .canvas-gen-node__settings")).toMatch(
      /overflow-y:\s*visible/,
    );
  });
});

describe("视频拼接与合成节点", () => {
  it("提供固定工具节点尺寸和可触达的顺序按钮", () => {
    expect(cssRule(".canvas-video-composer")).toMatch(/width:\s*580px/);
    expect(cssRule(".canvas-video-composer")).toMatch(/height:\s*500px/);
    expect(cssRule(".canvas-video-composer__input-actions button")).toMatch(/min-width:\s*44px/);
    expect(cssRule(".canvas-video-composer__input-actions button")).toMatch(/height:\s*44px/);
  });
});

describe("底部工作流仓库", () => {
  it("占用独立底部网格行并在折叠时保持紧凑", () => {
    expect(cssRule(".workspace-shell")).toMatch(/"workflows"\s+auto/);
    expect(cssRule(".workflow-repository")).toMatch(/grid-area:\s*workflows/);
    expect(cssRule(".workflow-repository")).toMatch(/height:\s*3\.25rem/);
    expect(cssRule(".workflow-repository--expanded")).toMatch(
      /height:\s*clamp\(12rem,\s*25vh,\s*15rem\)/,
    );
  });

  it("隐藏折叠内容并保留可触达的主要操作", () => {
    expect(cssRule(".workflow-repository__content[hidden]")).toMatch(/display:\s*none/);
    expect(cssRule(".workflow-repository__insert")).toMatch(/min-height:\s*var\(--size-control\)/);
  });
});

describe("剧本节点文本选中复制", () => {
  it("编剧助手对话区与剧本预览框允许选中文字，而不是继承节点卡片的禁止选中", () => {
    expect(cssRule(".canvas-screenplay-node__conversation")).toMatch(
      /-webkit-user-select:\s*text;\s*user-select:\s*text/,
    );
    expect(cssRule(".canvas-screenplay-node__document-preview")).toMatch(
      /-webkit-user-select:\s*text;\s*user-select:\s*text/,
    );
  });
});

describe("画布连线交互", () => {
  it("把用户看见的节点端口本身作为 React Flow 的可拖拽热区", () => {
    const handleRule = cssRule(".canvas-flow-handle");
    expect(handleRule).toMatch(/width:\s*24px/);
    expect(handleRule).toMatch(/height:\s*24px/);
    expect(handleRule).toMatch(/background:\s*var\(--color-paper\)/);
    expect(handleRule).toMatch(/border:\s*var\(--rule-active\)\s+solid\s+var\(--color-accent\)/);
    expect(handleRule).toMatch(/border-radius:\s*var\(--radius-round\)/);
    expect(handleRule).toMatch(/cursor:\s*crosshair/);
    expect(handleRule).not.toMatch(/opacity:\s*0/);
    expect(appCss).toMatch(
      /\.canvas-react-flow \.canvas-flow-node \.node-port,[\s\S]*?\.canvas-video-downloader__output-port\s*\{[^}]*display:\s*none/,
    );
  });

  it("提供宽命中区、顺序标记与可见删除控件", () => {
    expect(cssRule(".edge-hit-target")).toMatch(/stroke-width:\s*18/);
    expect(cssRule(".edge-hit-target")).toMatch(/pointer-events:\s*stroke/);
    expect(cssRule(".edge-order-marker text")).toMatch(/text-anchor:\s*middle/);
    expect(cssRule(".edge-delete-control")).toMatch(/opacity:\s*0/);
    expect(appCss).toMatch(
      /\.edge-group--removable\.is-selected\s+\.edge-delete-control[^{]*\{[^}]*opacity:\s*1/,
    );
  });
});

describe("画布视口控件", () => {
  it("回到起始位置与前两组控件同一底边、依次左移且互不重叠", () => {
    const zoom = cssRule(".zoom-control");
    const history = cssRule(".canvas-history-control");
    const home = cssRule(".canvas-home-control");
    // 三组控件共用底边基准，右起依次为：缩放（9rem）→ 撤销/重做（4.5rem）→ 回到起始位置（2.25rem）。
    expect(zoom).toMatch(/right:\s*var\(--space-md\)/);
    expect(history).toMatch(
      /right:\s*calc\(var\(--space-md\) \+ 9rem \+ 2 \* var\(--rule-thin\) \+ var\(--space-2xs\)\)/,
    );
    expect(home).toMatch(
      /right:\s*calc\(var\(--space-md\) \+ 9rem \+ 4\.5rem \+ 4 \* var\(--rule-thin\) \+ 2 \* var\(--space-2xs\)\)/,
    );
    for (const rule of [zoom, history, home]) {
      expect(rule).toMatch(/bottom:\s*var\(--size-zoom-collapsed-offset\)/);
      expect(rule).toMatch(/min-height:\s*2\.25rem/);
    }
    expect(history).toMatch(/grid-template-columns:\s*2\.25rem 2\.25rem/);
    expect(home).toMatch(/grid-template-columns:\s*2\.25rem/);
  });
});
