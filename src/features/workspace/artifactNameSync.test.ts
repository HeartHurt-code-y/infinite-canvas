import { describe, expect, it } from "vitest";
import type { OutputNodeData } from "./workspaceModel";
import { applyArtifactNameChange, createArtifactNameSync } from "./artifactNameSync";

const change = {
  taskId: "task-1",
  resultIndex: 1,
  finalPath: "C:\\Outputs\\镜头.mp4",
  name: "第01集_镜头003_选用.mp4",
};

function node(key: string, overrides: Partial<OutputNodeData> = {}): OutputNodeData {
  return {
    key,
    taskId: "task-1",
    resultKey: "task-1#0",
    sourceNodeId: "generation-node",
    name: "旧名称.mp4",
    mediaType: "video",
    finalPath: "C:/Outputs/镜头.mp4",
    previewSrc: "asset://original",
    x: 0,
    y: 0,
    ...overrides,
  };
}

function store(initial: OutputNodeData[]) {
  let nodes = initial;
  return {
    get nodes() {
      return nodes;
    },
    patch: (update: (node: OutputNodeData) => OutputNodeData) => {
      let count = 0;
      nodes = nodes.map((current) => {
        const next = update(current);
        if (next !== current) count += 1;
        return next;
      });
      return count;
    },
  };
}

describe("artifact name synchronization", () => {
  it("会话新名称优先于迟到的数据库旧名，也适用于之后新加入的卡片", () => {
    const sync = createArtifactNameSync();
    sync.publish(change);
    expect(
      sync.resolve(node("late", { name: "数据库旧名称.mp4", customName: "数据库旧名称.mp4" })).name,
    ).toBe(change.name);
  });
  it("updates all mounted canvases by task and saved path despite legacy result keys", () => {
    const sync = createArtifactNameSync();
    const first = store([node("a"), node("b", { resultKey: "task-1#1" })]);
    const second = store([node("copy", { resultKey: null })]);
    sync.register(first.patch);
    sync.register(second.patch);
    expect(sync.publish(change)).toBe(3);
    for (const current of [...first.nodes, ...second.nodes]) {
      expect(current.name).toBe(change.name);
      expect(current.customName).toBe(change.name);
      expect(current.finalPath).toBe("C:/Outputs/镜头.mp4");
      expect(current.previewSrc).toBe("asset://original");
    }
    expect(first.nodes[0]?.resultKey).toBe("task-1#0");
    expect(sync.publish(change)).toBe(0);
  });

  it("rejects other tasks, paths and unsaved placeholders even when keys appear equal", () => {
    for (const current of [
      node("other-task", { taskId: "task-2" }),
      node("other-path", { finalPath: "C:/Outputs/其他结果.mp4" }),
      node("pending", { finalPath: null }),
    ])
      expect(applyArtifactNameChange(current, change)).toBe(current);
    const unix = node("unix", { finalPath: "/outputs/Take.mp4" });
    expect(applyArtifactNameChange(unix, { ...change, finalPath: "/outputs/take.mp4" })).toBe(unix);
  });

  it("replays the latest name after hydration and stops updating an unmounted canvas", () => {
    const sync = createArtifactNameSync();
    sync.publish(change);
    sync.publish({ ...change, name: "新选用.mp4" });
    const hydrated = store([node("late")]);
    const unregister = sync.register(hydrated.patch);
    expect(hydrated.nodes[0]?.name).toBe("新选用.mp4");
    unregister();
    sync.publish({ ...change, name: "之后的版本.mp4" });
    expect(hydrated.nodes[0]?.name).toBe("新选用.mp4");
    sync.register(hydrated.patch);
    expect(hydrated.nodes[0]?.name).toBe("之后的版本.mp4");
  });

  it("notifies history subscribers only on explicit publication and validates identity", () => {
    const sync = createArtifactNameSync();
    const received: string[] = [];
    const unsubscribe = sync.subscribe((event) => received.push(event.name));
    expect(() => sync.publish({ ...change, taskId: "" })).toThrow();
    sync.publish(change);
    expect(received).toEqual([change.name]);
    unsubscribe();
    sync.publish({ ...change, name: "另一个名称.mp4" });
    expect(received).toEqual([change.name]);
  });
});
