import { describe, expect, it } from "vitest";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";
import { createProductSceneOptions } from "./productSceneWorkflowModel";
import { createMusicVideoOptions } from "./musicVideoWorkflowModel";
import { createBrandVideoOptions } from "./brandVideoWorkflowModel";
import { createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import {
  WORKFLOW_KIND_IDS,
  WORKFLOW_KINDS,
  workflowKindDefinitionOf,
  workflowKindOf,
} from "./workflowKinds";
import type { RecordedClients } from "./workflowRunnerContract";

/** 注册顺序 = 仓库卡片顺序 = 判定优先级，此处锁死以免卡片排列被无意重排。 */
const EXPECTED_ORDER = [
  "productScene",
  "reelbench",
  "musicVideo",
  "reverseVideo",
  "xhsCover",
  "knowledge",
  "film",
  "comicDrama",
  "commerce",
  "brandVideo",
  "remotion",
] as const;

/** 与 Rust `WorkflowKind::as_str`（src-tauri storage/workflow_history.rs）逐字对应。 */
const RUST_WORKFLOW_KIND_AS_STR = [
  "knowledge",
  "film",
  "comicDrama",
  "musicVideo",
  "brandVideo",
  "commerce",
  "remotion",
  "xhsCover",
  "productScene",
  "reverseVideo",
  "reelbench",
] as const;

const configWith = (field: string): KnowledgeVideoWorkflowConfig =>
  field === ""
    ? ({ brief: "" } as unknown as KnowledgeVideoWorkflowConfig)
    : ({ brief: "", [field]: {} }) as unknown as KnowledgeVideoWorkflowConfig;

const FAKE_CLIENTS = {
  promptClient: {},
  generationClient: {},
} as unknown as RecordedClients;

describe("workflowKinds registry", () => {
  it("registers exactly the eleven workflow kinds in repository card order", () => {
    expect(WORKFLOW_KIND_IDS).toEqual(EXPECTED_ORDER);
    expect(new Set(WORKFLOW_KIND_IDS).size).toBe(WORKFLOW_KINDS.length);
  });

  it("stays in parity with the Rust WorkflowKind enum", () => {
    expect([...WORKFLOW_KIND_IDS].sort()).toEqual([...RUST_WORKFLOW_KIND_AS_STR].sort());
  });

  it("detects each kind by its dedicated config field", () => {
    for (const entry of WORKFLOW_KINDS) {
      if (entry.id === "knowledge") continue;
      // 每个类型的判定字段与其 id 同名（config.productScene / config.reelbench / …）。
      expect(workflowKindOf(configWith(entry.id))).toBe(entry.id);
    }
  });

  it("falls back to the knowledge kind when no dedicated field is set", () => {
    expect(workflowKindOf(configWith(""))).toBe("knowledge");
  });

  it("resolves detection by registration order for multi-field configs", () => {
    // 现实中一个配置只带一个工作流字段；此用例锁定「首个命中即成立」的语义。
    const both = {
      brief: "",
      reelbench: {},
      productScene: {},
    } as unknown as KnowledgeVideoWorkflowConfig;
    expect(workflowKindOf(both)).toBe("productScene");
  });

  it("exposes display copy and repository card data for every kind", () => {
    for (const entry of WORKFLOW_KINDS) {
      expect(entry.nodeTitle.length).toBeGreaterThan(0);
      expect(entry.historyTitle.length).toBeGreaterThan(0);
      expect(entry.insertTitle.length).toBeGreaterThan(0);
      expect(entry.insertToastDescription.length).toBeGreaterThan(0);
      expect(entry.repository.title.length).toBeGreaterThan(0);
      expect(entry.repository.description.length).toBeGreaterThan(0);
      expect(entry.repository.stages).toHaveLength(4);
      expect(entry.repository.insertLabel.length).toBeGreaterThan(0);
      expect(workflowKindDefinitionOf(entry.id)).toBe(entry);
    }
  });

  it("provides delivery markdown exactly for the seven document-capable kinds", () => {
    const documentKinds = new Set([
      "film",
      "comicDrama",
      "musicVideo",
      "commerce",
      "brandVideo",
      "remotion",
      "xhsCover",
    ]);
    for (const entry of WORKFLOW_KINDS) {
      expect(entry.deliveryMarkdown != null).toBe(documentKinds.has(entry.id));
    }
  });

  it("snapshots model roles per kind", () => {
    const roles = (id: string) => workflowKindDefinitionOf(id as never).historyRoles;
    expect(roles("remotion")(configWith("remotion"))).toEqual(["text"]);
    expect(roles("reverseVideo")(configWith("reverseVideo"))).toEqual(["text"]);
    expect(roles("reelbench")(configWith("reelbench"))).toEqual(["text"]);
    expect(roles("knowledge")(configWith(""))).toEqual(["text", "image", "video"]);
    expect(roles("film")(configWith("film"))).toEqual(["text", "image", "video"]);
    expect(roles("comicDrama")(configWith("comicDrama"))).toEqual(["text", "image", "video"]);
    expect(roles("commerce")(configWith("commerce"))).toEqual(["text", "image", "video"]);
    expect(roles("productScene")(configWith("productScene"))).toEqual(["image"]);
    expect(roles("musicVideo")(configWith("musicVideo"))).toEqual(["text", "image", "video"]);
    expect(roles("brandVideo")(configWith("brandVideo"))).toEqual(["text", "video"]);
    expect(roles("xhsCover")(configWith("xhsCover"))).toEqual(["text", "image"]);
  });

  it("widens model roles for document and quality switches", () => {
    const musicVideo = workflowKindDefinitionOf("musicVideo");
    expect(musicVideo.historyRoles({ musicVideo: createMusicVideoOptions() } as never)).toEqual([
      "text",
      "image",
      "video",
    ]);
    expect(
      musicVideo.historyRoles({
        musicVideo: { ...createMusicVideoOptions(), deliverable: "documents" },
      } as never),
    ).toEqual(["text"]);

    const brandVideo = workflowKindDefinitionOf("brandVideo");
    expect(brandVideo.historyRoles({ brandVideo: createBrandVideoOptions() } as never)).toEqual([
      "text",
      "video",
    ]);

    const xhsCover = workflowKindDefinitionOf("xhsCover");
    expect(xhsCover.historyRoles({ xhsCover: createXhsCoverOptions() } as never)).toEqual([
      "text",
      "image",
    ]);

    const productScene = workflowKindDefinitionOf("productScene");
    expect(
      productScene.historyRoles({ productScene: createProductSceneOptions() } as never),
    ).toEqual(["image"]);
  });

  it("loads an insert template for every kind", async () => {
    for (const entry of WORKFLOW_KINDS) {
      const createTemplate = await entry.loadTemplate();
      expect(typeof createTemplate).toBe("function");
    }
  });

  it("builds a runner for every kind from recorded clients", () => {
    for (const entry of WORKFLOW_KINDS) {
      const runner = entry.createRunner(FAKE_CLIENTS);
      expect(typeof runner.run).toBe("function");
    }
  });
});
