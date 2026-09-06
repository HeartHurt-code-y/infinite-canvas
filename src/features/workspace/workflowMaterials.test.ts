import { describe, expect, it, vi } from "vitest";
import type { OptimizeVideoPromptCommand } from "../../lib/backend";
import { node } from "../../test/videoWorkflowFixtures";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
} from "../../test/workflowMaterialFixtures";
import { createCommerceOptions } from "./commerceWorkflowModel";
import { createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import {
  MAX_WORKFLOW_MATERIAL_BYTES,
  mergeWorkflowMaterials,
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
  workflowReferenceMaterials,
} from "./workflowMaterials";

const command: OptimizeVideoPromptCommand = {
  providerConnectionId: "project-provider",
  modelDefinitionId: "project-text",
  mode: "knowledge_video_director",
  userPrompt: "使用参考素材制作视频",
};

describe("workflow reference materials", () => {
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
});
