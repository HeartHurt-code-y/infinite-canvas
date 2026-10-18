import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createKnowledgeVideoWorkflowConfig } from "../features/workspace/workspaceModel";
import {
  initializeWorkflowVersions,
  recordWorkflowVersion,
  restoreWorkflowVersion,
  redoWorkflowVersion,
  workflowVersionState,
  type WorkflowVersionHistory,
} from "../features/workspace/workflowVersionHistory";
import {
  decodeWorkflowVersionDocument,
  decodeWorkflowVersionHistory,
  encodeWorkflowVersionDocument,
  encodeWorkflowVersionHistory,
} from "./workflowVersionStorage";

const fresh = () =>
  createKnowledgeVideoWorkflowConfig(
    {
      prompt: { providerId: "p", modelDefinitionId: "text" },
      image: { providerId: "p", modelDefinitionId: "image" },
      video: { providerId: "p", modelDefinitionId: "video" },
    },
    true,
  );
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function history(count = 35): WorkflowVersionHistory {
  const config = {
    ...fresh(),
    brief: "测试",
    checkpoint: {
      ...fresh().checkpoint,
      script: "共同正文".repeat(4000),
      runId: "paid-run",
      finalPath: "C:/output/final.mp4",
    },
    parameters: {
      rows: Array.from({ length: 500 }, (_, i) => ({
        id: i,
        prompt: `镜头 ${i} ` + "共同提示词".repeat(20),
        value: 0,
      })),
    },
  };
  const versions = Array.from({ length: count }, (_, i) => ({
    id: `v${i}`,
    parentId: i ? `v${i - 1}` : null,
    createdAt: i,
    label: `阶段 ${i}`,
    config: {
      ...config,
      parameters: {
        rows: config.parameters.rows.map((row) => (row.id === 10 ? { ...row, value: i } : row)),
      },
    },
  }));
  return {
    version: 1,
    currentVersionId: versions.at(-1)!.id,
    versions,
    preferredChildByVersion: Object.fromEntries(versions.slice(1).map((v) => [v.parentId!, v.id])),
    runtimeArchives: [
      {
        ...config,
        historyRunId: "earlier-run",
        checkpoint: { ...config.checkpoint, runId: "earlier-run" },
      },
    ],
  };
}

describe("incremental workflow version storage", () => {
  it("recovers the shared Rust fixture after credential and inline-media sanitization", () => {
    const marker = "<内联图片数据已排除>";
    const stored = JSON.parse(
      readFileSync(
        new URL(
          "../../src-tauri/src/backend/storage/fixtures/workflow-version-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      contents: [
        { value: { apiKey?: string; checkpoint: Record<string, unknown> } },
        { patch: { changes: { checkpoint: { changes: Record<string, unknown> } } } },
      ];
    };
    delete stored.contents[0].value.apiKey;
    for (const field of ["base64", "b64_json"]) {
      stored.contents[0].value.checkpoint[field] = marker;
      stored.contents[1].patch.changes.checkpoint.changes[field] = marker;
    }
    const restored = decodeWorkflowVersionHistory(stored);
    for (const version of restored.versions) {
      expect(version.config).not.toHaveProperty("apiKey");
      expect(version.config.checkpoint).toMatchObject({
        runId: "paid-run",
        finalPath: "C:/output/final.mp4",
        base64: marker,
        b64_json: marker,
      });
    }
  });

  it("preserves older runtime-only archives that do not carry model selections", () => {
    const original = history(2);
    const archive = { ...original.runtimeArchives![0]! } as Record<string, unknown>;
    delete archive["models"];
    const legacy = { ...original, runtimeArchives: [archive] } as unknown as WorkflowVersionHistory;
    expect(decodeWorkflowVersionHistory(json(encodeWorkflowVersionHistory(legacy)))).toEqual(
      legacy,
    );
  });
  it("round-trips every version/archive and uses periodic full checkpoints with small row deltas", () => {
    const original = { ...history(), extension: { note: "保留已有扩展字段" } };
    const stored = encodeWorkflowVersionHistory(original) as {
      version: number;
      contents: { kind: string }[];
    };
    expect(stored.version).toBe(2);
    expect(stored.contents[0]?.kind).toBe("full");
    expect(stored.contents[16]?.kind).toBe("full");
    expect(stored.contents[32]?.kind).toBe("full");
    expect(stored.contents[1]?.kind).toBe("delta");
    expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(original).length * 0.15);
    expect(decodeWorkflowVersionHistory(json(stored))).toEqual(original);
    expect(encodeWorkflowVersionHistory(original)).toBe(stored);
    expect(decodeWorkflowVersionHistory(original)).toBe(original);
  });

  it("preserves deletion, array resizing, type changes, Unicode and prototype-named JSON keys", () => {
    const data = [
      { list: [1, { '引号"': "正文" }, null], obsolete: true, option: { nested: 1 } },
      { list: [1, { '引号"': "修改" }, null, "新增"], option: false },
      {
        list: [null],
        option: { back: "value" },
        ...(JSON.parse('{"__proto__":{"polluted":true}}') as object),
      },
    ];
    const base = fresh();
    const versions = data.map((parameters, i) => ({
      id: `v${i}`,
      parentId: i ? `v${i - 1}` : null,
      createdAt: i,
      label: "编辑",
      config: { ...base, brief: "a".repeat(2000), parameters },
    }));
    const source: WorkflowVersionHistory = {
      version: 1,
      currentVersionId: "v2",
      versions,
      preferredChildByVersion: { v0: "v1", v1: "v2" },
    };
    expect(decodeWorkflowVersionHistory(json(encodeWorkflowVersionHistory(source)))).toEqual(
      source,
    );
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("keeps branches, redo preferences, paid-task archives and approval invalidation after reload", () => {
    let value = initializeWorkflowVersions({ ...fresh(), brief: "原稿" });
    const root = value.versionHistory!.currentVersionId;
    value = recordWorkflowVersion(value, {
      ...value,
      checkpoint: { ...value.checkpoint, phase: "planning", lastActivePhase: "planning" },
    });
    const left = value.versionHistory!.currentVersionId;
    value = recordWorkflowVersion(value, {
      ...value,
      checkpoint: {
        ...value.checkpoint,
        phase: "generating",
        lastActivePhase: "generating",
        runId: "paid-run",
        coverImagePath: "C:/cover.png",
      },
    });
    value = restoreWorkflowVersion(value, root);
    value = recordWorkflowVersion(value, { ...value, brief: "新分支" });
    const branch = value.versionHistory!.currentVersionId;
    const document = {
      version: 2,
      knowledgeVideoWorkflowNodes: [
        { key: "workflow", kind: "knowledge_video_workflow", x: 0, y: 0, config: value },
      ],
    };
    const loaded = decodeWorkflowVersionDocument(
      json(encodeWorkflowVersionDocument(document)),
    ) as typeof document;
    let current = loaded.knowledgeVideoWorkflowNodes[0]!.config;
    expect(workflowVersionState(current).versions.map((v) => v.id)).toContain(left);
    expect(
      current.versionHistory?.runtimeArchives?.some(
        (archive) => archive.checkpoint.runId === "paid-run",
      ),
    ).toBe(true);
    current = restoreWorkflowVersion(current, root);
    current = redoWorkflowVersion(current, branch);
    expect(current.brief).toBe("新分支");
    expect(current.executionPlan?.approval).toBeNull();
  });

  it.each(["base", "content", "parent", "redo", "array", "operation"])(
    "rejects damaged %s data before returning a partial history",
    (field) => {
      const stored = json(encodeWorkflowVersionHistory(history(3))) as {
        contents: { base?: number; patch?: unknown }[];
        versions: { content: number; parentId: string | null }[];
        preferredChildByVersion: Record<string, string>;
      };
      if (field === "base") stored.contents[1]!.base = 1;
      if (field === "content") stored.versions[1]!.content = 999;
      if (field === "parent") stored.versions[0]!.parentId = "v2";
      if (field === "redo") stored.preferredChildByVersion["v0"] = "v2";
      if (field === "array")
        stored.contents[1]!.patch = {
          kind: "object",
          removed: [],
          changes: {
            parameters: {
              kind: "object",
              removed: [],
              changes: { rows: { kind: "array", length: 1_000_000_000, changes: [] } },
            },
          },
        };
      if (field === "operation") stored.contents[1]!.patch = { kind: "unknown" };
      expect(() => decodeWorkflowVersionHistory(stored)).toThrow("记录损坏");
    },
  );

  it("shares only owned immutable snapshot subtrees and restores an independent editable copy", () => {
    const source = { ...fresh(), brief: "原稿" };
    const first = initializeWorkflowVersions(source);
    const original = first.versionHistory!.versions[0]!.config;
    const second = recordWorkflowVersion(first, {
      ...first,
      checkpoint: { ...first.checkpoint, phase: "planning", lastActivePhase: "planning" },
    });
    const next = second.versionHistory!.versions[1]!.config;
    expect(next.models).toBe(original.models);
    expect(next.models).not.toBe(source.models);
    const restored = restoreWorkflowVersion(second, first.versionHistory!.currentVersionId);
    expect(restored.models).not.toBe(original.models);
    expect(source.models).toEqual(fresh().models);
  });

  it("keeps the previous JSON snapshot normalization for sparse arrays and non-finite numbers", () => {
    const source = {
      ...fresh(),
      extra: {
        zero: -0,
        nan: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
        sparse: Array.from({ length: 3 }),
        omitted: undefined,
      },
    };
    const versioned = initializeWorkflowVersions(source);
    expect(versioned.versionHistory!.versions[0]!.config).toStrictEqual(json(source));
  });

  it("rejects a tiny record that amplifies beyond the expanded recovery budget", () => {
    const config = { ...fresh(), brief: "x".repeat(1_000_000) };
    const versions = Array.from({ length: 270 }, (_, index) => ({
      id: `v${index}`,
      parentId: index ? `v${index - 1}` : null,
      label: "阶段",
      createdAt: index,
      config,
    }));
    const source: WorkflowVersionHistory = {
      version: 1,
      versions,
      currentVersionId: "v269",
      preferredChildByVersion: {},
    };
    expect(() => encodeWorkflowVersionHistory(source)).toThrow("超过256MiB");
    const stored = {
      version: 2,
      currentVersionId: source.currentVersionId,
      preferredChildByVersion: {},
      versions: versions.map((version) => ({
        id: version.id,
        parentId: version.parentId,
        label: version.label,
        createdAt: version.createdAt,
        content: 0,
      })),
      contents: [{ kind: "full", value: config }],
    };
    expect(() => decodeWorkflowVersionHistory(json(stored))).toThrow("超过256MiB");
  });

  it("rejects delta chains beyond the checkpoint bound", () => {
    const stored = json(encodeWorkflowVersionHistory(history(2))) as { contents: unknown[] };
    stored.contents = [
      stored.contents[0],
      ...Array.from({ length: 16 }, (_, index) => ({
        kind: "delta",
        base: index,
        patch: { kind: "object", changes: {}, removed: [] },
      })),
    ];
    expect(() => decodeWorkflowVersionHistory(stored)).toThrow("记录损坏");
  });
});
