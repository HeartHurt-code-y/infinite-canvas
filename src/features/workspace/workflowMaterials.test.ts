import { describe, expect, it, vi } from "vitest";
import type {
  OptimizeVideoPromptCommand,
  PromptReferenceInput,
  PromptNodeClient,
} from "../../lib/backend";
import { node } from "../../test/videoWorkflowFixtures";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";
import { createCommerceOptions } from "./commerceWorkflowModel";
import { createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import {
  MAX_WORKFLOW_MATERIAL_BYTES,
  mergeWorkflowMaterials,
  mergeWorkflowReferenceInputs,
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
  workflowReferenceMaterials,
  workflowConnectedMaterials,
  workflowMaterialQuota,
} from "./workflowMaterials";

const command: OptimizeVideoPromptCommand = {
  providerConnectionId: "project-provider",
  modelDefinitionId: "project-text",
  mode: "knowledge_video_director",
  userPrompt: "使用参考素材制作视频",
};

describe("workflow reference materials", () => {
  it("shares capacity with connected media and deduplicates repeated source instances", () => {
    const config = {
      ...node().config,
      materials: workflowReferenceFixtures,
      connectedMaterials: [
        ...workflowConnectedReferenceFixtures,
        {
          ...workflowConnectedReferenceFixtures[0]!,
          target: {
            ...workflowConnectedReferenceFixtures[0]!.target,
            canvasNodeKey: "another-instance",
          },
        },
        {
          displayName: "已有本地参考图",
          target: {
            kind: "local_file" as const,
            path: "c:/REFERENCE/visual.png",
            mediaType: "image" as const,
          },
        },
      ],
    };
    expect(workflowConnectedMaterials(config)).toHaveLength(3);
    expect(workflowMaterialQuota(config)).toEqual({ count: 6, localBytes: 400, connectedCount: 2 });
    expect(() => validateWorkflowMaterials(config)).not.toThrow();
    expect(mergeWorkflowReferenceInputs(config, [], workflowReferenceInputs)).toEqual(
      workflowConnectedReferenceFixtures,
    );
  });

  it("counts distinct cloud providers and result indexes as separate media sources", () => {
    const connectedMaterials: readonly PromptReferenceInput[] = [
      ...workflowConnectedReferenceFixtures,
      {
        displayName: "另一个供应商的同名素材",
        target: {
          kind: "asset",
          assetId: "cloud-image",
          providerConnectionId: "other",
          mediaType: "image",
        },
      },
      ...[0, 1].map((resultIndex) => ({
        displayName: `视频产物 ${resultIndex}`,
        target: {
          kind: "local_result" as const,
          generationTaskId: "task",
          resultIndex,
          mediaType: "video" as const,
        },
      })),
    ];
    const config = { ...node().config, connectedMaterials };
    expect(workflowMaterialQuota(config).count).toBe(5);
    expect(() =>
      validateWorkflowMaterials({ ...config, materials: workflowReferenceFixtures }),
    ).toThrow("合计最多 8 项");
  });

  it("forwards connected-only context to every call while retaining dedicated evidence", async () => {
    const client = {
      run: vi
        .fn<PromptNodeClient["run"]>()
        .mockResolvedValue({ optimizedPrompt: "ok", rawModelOutput: "ok" }),
    };
    const config = { ...node().config, connectedMaterials: workflowConnectedReferenceFixtures };
    const visionImages = [
      {
        displayName: "系统采样帧",
        target: {
          kind: "local_file" as const,
          path: "C:\\frames\\1.png",
          mediaType: "image" as const,
        },
      },
    ];
    for (const mode of [
      "knowledge_video_director",
      "knowledge_video_director",
      "knowledge_video_qc",
    ] as const) {
      await withWorkflowMaterials(client, config).run({ ...command, mode, visionImages });
    }
    expect(client.run).toHaveBeenCalledTimes(3);
    for (const [input] of client.run.mock.calls) {
      expect(input.referenceInputs).toEqual(workflowConnectedReferenceFixtures);
      expect(input.visionImages).toBe(visionImages);
      expect(input.multimodalInputs).toBeUndefined();
    }
    expect(config).not.toHaveProperty("commerce");
    expect(config).not.toHaveProperty("xhsCover");
  });

  it("merges per-call media references before connected inputs and rejects aggregate overflow", () => {
    const config = { ...node().config, connectedMaterials: workflowConnectedReferenceFixtures };
    expect(mergeWorkflowReferenceInputs(config, [workflowConnectedReferenceFixtures[1]!])).toEqual([
      workflowConnectedReferenceFixtures[1],
      workflowConnectedReferenceFixtures[0],
    ]);
    const extraFiles = Array.from({ length: 7 }, (_, index) => ({
      ...workflowReferenceInputs[0]!,
      localPath: `C:\\frames\\${index}.png`,
    }));
    expect(() => mergeWorkflowMaterials(config, extraFiles)).toThrow(
      "本轮工作流参考素材合计超过 8 项",
    );
  });

  it("shares capacity across common and dedicated roles using Windows path identity", () => {
    const image = workflowReferenceFixtures[0]!;
    const config = {
      ...node().config,
      materials: workflowReferenceFixtures,
      commerce: { ...createCommerceOptions(), materials: [image] },
      xhsCover: {
        ...createXhsCoverOptions(),
        portraits: [{ ...image, localPath: "c:/REFERENCE/visual.png" }],
      },
    };
    expect(workflowReferenceMaterials(config)).toEqual(workflowReferenceFixtures);
    expect(() => validateWorkflowMaterials(config)).not.toThrow();
  });

  it("appends common materials after dedicated references, deduplicates and passes metadata only", () => {
    const config = { ...node().config, materials: workflowReferenceFixtures };
    const image = workflowReferenceFixtures[0]!;
    const references = mergeWorkflowMaterials(config, [image]);
    expect(references).toEqual(workflowReferenceInputs);
    expect(references.every((material) => !Object.hasOwn(material, "byteSize"))).toBe(true);
  });

  it("rejects overflow from different material roles before starting a paid request", () => {
    const image = workflowReferenceFixtures[0]!;
    const config = {
      ...node().config,
      materials: Array.from({ length: 8 }, (_, index) => ({
        ...image,
        localPath: `C:\\reference\\${index}.png`,
      })),
      commerce: { ...createCommerceOptions(), materials: [image] },
    };
    expect(() => validateWorkflowMaterials(config)).toThrow("合计最多 8 项");
  });

  it("rejects oversized or empty material metadata", () => {
    const image = workflowReferenceFixtures[0]!;
    for (const byteSize of [0, Number.NaN, MAX_WORKFLOW_MATERIAL_BYTES + 1]) {
      expect(() =>
        validateWorkflowMaterials({ ...node().config, materials: [{ ...image, byteSize }] }),
      ).toThrow("14 MB");
    }
    expect(() =>
      validateWorkflowMaterials({
        ...node().config,
        materials: [{ ...image, byteSize: MAX_WORKFLOW_MATERIAL_BYTES }],
        commerce: { ...createCommerceOptions(), materials: [workflowReferenceFixtures[3]!] },
      }),
    ).toThrow("14 MB");
  });

  it("keeps the exact legacy request when no general material was attached", async () => {
    const client = {
      run: vi.fn().mockResolvedValue({ optimizedPrompt: "ok", rawModelOutput: "ok" }),
    };
    await withWorkflowMaterials(client, node().config).run(command);
    expect(client.run.mock.calls[0]?.[0]).toBe(command);
  });

  it("keeps visual evidence and existing image order while forwarding all reference kinds", async () => {
    const client = {
      run: vi.fn().mockResolvedValue({ optimizedPrompt: "ok", rawModelOutput: "ok" }),
    };
    const original = {
      ...command,
      multimodalInputs: [workflowReferenceInputs[0]!],
      visionImages: [
        {
          displayName: "采样帧",
          target: {
            kind: "local_file" as const,
            path: "C:\\frames\\1.png",
            mediaType: "image" as const,
          },
        },
      ],
    };
    await withWorkflowMaterials(client, {
      ...node().config,
      materials: workflowReferenceFixtures,
    }).run(original);
    expect(client.run).toHaveBeenCalledWith({
      ...original,
      multimodalInputs: workflowReferenceInputs,
    });
  });

  it("resumes a legacy empty checkpoint but rejects newly added references", () => {
    const source = node();
    expect(() =>
      validateWorkflowMaterialsResume(source.config, source.config.checkpoint),
    ).not.toThrow();
    expect(() =>
      validateWorkflowMaterialsResume(
        { ...source.config, materials: workflowReferenceFixtures },
        source.config.checkpoint,
      ),
    ).toThrow("参考素材已修改");
  });

  it("survives metadata key reordering and rejects material removal, reordering or replacement", () => {
    const config = { ...node().config, materials: workflowReferenceFixtures };
    const checkpoint = {
      ...config.checkpoint,
      materialsSignature: workflowMaterialsSignature(config),
    };
    const restored = JSON.parse(JSON.stringify(config)) as typeof config;
    expect(() => validateWorkflowMaterialsResume(restored, checkpoint)).not.toThrow();
    for (const materials of [
      [],
      [...workflowReferenceFixtures].reverse(),
      workflowReferenceFixtures.map((material) => ({
        ...material,
        byteSize: material.byteSize + 1,
      })),
    ]) {
      expect(() => validateWorkflowMaterialsResume({ ...config, materials }, checkpoint)).toThrow(
        "参考素材已修改",
      );
    }
  });

  it("preserves legacy signatures with empty connections and invalidates changed source identity or order", () => {
    const source = node().config;
    expect(workflowMaterialsSignature(source)).toBe("[]");
    expect(workflowMaterialsSignature({ ...source, connectedMaterials: [] })).toBe("[]");
    const config = { ...source, connectedMaterials: workflowConnectedReferenceFixtures };
    const checkpoint = {
      ...source.checkpoint,
      materialsSignature: workflowMaterialsSignature(config),
    };
    const renamedInstances = {
      ...config,
      connectedMaterials: config.connectedMaterials.map((reference) => ({
        ...reference,
        displayName: "更新名称",
        target: { ...reference.target, canvasNodeKey: "new-instance" },
      })),
    };
    expect(() => validateWorkflowMaterialsResume(renamedInstances, checkpoint)).not.toThrow();
    for (const connectedMaterials of [
      [],
      [...config.connectedMaterials].reverse(),
      [config.connectedMaterials[0]!],
    ]) {
      expect(() =>
        validateWorkflowMaterialsResume({ ...config, connectedMaterials }, checkpoint),
      ).toThrow("参考素材已修改");
    }
    expect(() =>
      validateWorkflowMaterialsResume(
        {
          ...config,
          connectedMaterials: [
            {
              displayName: "replacement",
              target: {
                kind: "asset",
                providerConnectionId: "source-provider",
                assetId: "replacement",
                mediaType: "image",
              },
            },
            config.connectedMaterials[1]!,
          ],
        },
        checkpoint,
      ),
    ).toThrow("参考素材已修改");
    expect(workflowMaterialsSignature(config)).not.toContain("canvasNodeKey");
    expect(workflowMaterialsSignature(config)).not.toContain("displayName");
  });
});
