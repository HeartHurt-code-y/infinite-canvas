import * as v from "valibot";
import {
  cancelBlenderRender,
  createWhiteModelStudioDraft,
  getBlenderRender,
  startBlenderRender,
  whiteModelRenderRequest,
  whiteModelRenderSignature,
  type BlenderRenderJob,
  type WhiteModelStudioDraft,
} from "../../../lib/whiteModelStudio";
import { whiteModelPlanIssue, type WhiteModelScenePlan } from "../../../lib/whiteModelScene";
import { whiteModelMotionRefinementSchema } from "../../../lib/whiteModelMotionRefinement";
import { pruneWhiteModelCharacterBindings } from "../../../lib/whiteModelBlocking";
import type { AgentAction, AgentTool, AgentToolContext } from "./agentTypes";
import {
  applyAgentMotionEdit,
  parseAgentMotionEdit,
  motionEditInputSchema,
  motionRefinementInputSchema,
} from "./agentMotionRefinement";

export interface AgentBlenderHost {
  getDraft(nodeKey: string): WhiteModelStudioDraft | null;
  setDraft(nodeKey: string, draft: WhiteModelStudioDraft): Promise<void>;
  attachVideo(nodeKey: string, job: BlenderRenderJob): Promise<unknown>;
  openStudio(nodeKey: string): void;
}

const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.number(), v.finite(), v.minValue(minimum), v.maxValue(maximum));
const integer = (minimum: number, maximum: number) =>
  v.pipe(bounded(minimum, maximum), v.integer());
const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(160),
  v.check((s) => !!s.trim()),
);
const vector = v.tuple([bounded(-100, 100), bounded(-100, 100), bounded(-100, 100)]);
const time = bounded(0, 30);
const pathFrame = v.strictObject({ time, position: vector, yaw: v.pipe(v.number(), v.finite()) });
const cameraFrame = v.strictObject({ time, position: vector, target: vector });
const poseNames = ["stand", "sit", "kneel", "crouch", "reach", "arms_up"] as const;
const sceneSchema = v.strictObject({
  version: v.literal(2),
  durationSeconds: bounded(1, 30),
  fps: integer(8, 30),
  width: v.pipe(
    integer(320, 1920),
    v.check((n) => n % 2 === 0, "画幅宽度必须为偶数"),
  ),
  height: v.pipe(
    integer(180, 1920),
    v.check((n) => n % 2 === 0, "画幅高度必须为偶数"),
  ),
  camera: v.strictObject({
    lens: v.pipe(v.number(), v.finite(), v.minValue(1)),
    interpolation: v.picklist(["linear", "smooth"]),
    keyframes: v.pipe(v.array(cameraFrame), v.minLength(1), v.maxLength(256)),
    follow: v.nullable(v.strictObject({ actorId: identifier, mode: v.picklist(["aim", "track"]) })),
  }),
  objects: v.pipe(
    v.array(
      v.strictObject({
        id: identifier,
        name: identifier,
        shape: v.picklist(["box", "sphere", "cylinder", "person"]),
        color: v.pipe(v.string(), v.regex(/^#[\da-f]{6}$/i)),
        size: bounded(0.1, 10),
        facing: v.picklist(["path", "manual"]),
        keyframes: v.pipe(v.array(pathFrame), v.minLength(1), v.maxLength(256)),
        motion: v.variant("kind", [
          v.strictObject({ kind: v.literal("auto") }),
          v.strictObject({ kind: v.literal("pose"), pose: v.picklist(poseNames) }),
        ]),
        motionRefinement: v.exactOptional(whiteModelMotionRefinementSchema),
      }),
    ),
    v.minLength(1),
    v.maxLength(64),
  ),
});
const nodeArgs = v.strictObject({ nodeKey: identifier });
const sceneArgs = v.strictObject({ nodeKey: identifier, scene: sceneSchema });

const stringSchema = { type: "string", minLength: 1, maxLength: 160 };
const numericSchema = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const vectorSchema = { type: "array", items: numericSchema(-100, 100), minItems: 3, maxItems: 3 };
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const listSchema = (items: unknown, maxItems = 256) => ({
  type: "array",
  items,
  minItems: 1,
  maxItems,
});
const nodeInputSchema = objectSchema({ nodeKey: stringSchema });
const sceneInputSchema = objectSchema({
  nodeKey: stringSchema,
  scene: objectSchema({
    version: { type: "integer", const: 2 },
    durationSeconds: numericSchema(1, 30),
    fps: { type: "integer", minimum: 8, maximum: 30 },
    width: { type: "integer", minimum: 320, maximum: 1920, multipleOf: 2 },
    height: { type: "integer", minimum: 180, maximum: 1920, multipleOf: 2 },
    camera: objectSchema({
      lens: { type: "number", minimum: 1 },
      interpolation: { type: "string", enum: ["linear", "smooth"] },
      keyframes: listSchema(
        objectSchema({ time: numericSchema(0, 30), position: vectorSchema, target: vectorSchema }),
      ),
      follow: {
        anyOf: [
          { type: "null" },
          objectSchema({ actorId: stringSchema, mode: { type: "string", enum: ["aim", "track"] } }),
        ],
      },
    }),
    objects: listSchema(
      objectSchema(
        {
          id: stringSchema,
          name: stringSchema,
          shape: { type: "string", enum: ["box", "sphere", "cylinder", "person"] },
          color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
          size: numericSchema(0.1, 10),
          facing: { type: "string", enum: ["path", "manual"] },
          keyframes: listSchema(
            objectSchema({
              time: numericSchema(0, 30),
              position: vectorSchema,
              yaw: { type: "number" },
            }),
          ),
          motion: {
            anyOf: [
              objectSchema({ kind: { type: "string", const: "auto" } }),
              objectSchema({
                kind: { type: "string", const: "pose" },
                pose: { type: "string", enum: poseNames },
              }),
            ],
          },
          motionRefinement: motionRefinementInputSchema,
        },
        ["id", "name", "shape", "color", "size", "facing", "keyframes", "motion"],
      ),
      64,
    ),
  }),
});

function parseScene(args: unknown) {
  const parsed = v.parse(sceneArgs, args);
  if (new Set(parsed.scene.objects.map((actor) => actor.id)).size !== parsed.scene.objects.length) {
    throw new Error("白模角色和道具必须使用不同的标识。");
  }
  const issue = whiteModelPlanIssue(parsed.scene);
  if (issue) throw new Error(issue);
  return parsed;
}

function active(job: BlenderRenderJob) {
  return job.status === "queued" || job.status === "running";
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("白模任务已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Paths and captured joint buffers are host-owned and never part of model-authored arguments. */
function publicScene(draft: WhiteModelStudioDraft) {
  return {
    ...draft.plan,
    objects: draft.plan.objects.map((actor) => ({
      ...actor,
      motion:
        actor.motion.kind === "clip"
          ? {
              kind: "clip",
              sourceName: actor.motion.clip.sourceName,
              frameCount: actor.motion.clip.frameCount,
              fps: actor.motion.clip.fps,
              startTime: actor.motion.startTime,
              speed: actor.motion.speed,
              loop: actor.motion.loop,
              clipDataOmitted: true,
            }
          : actor.motion,
    })),
  };
}

/** UI-only simulation; clip buffers never enter model arguments or conversation history. */
export function previewAgentBlenderScenes(
  actions: readonly AgentAction[],
  getDraft: (nodeKey: string) => WhiteModelStudioDraft | null,
): ReadonlyMap<string, WhiteModelScenePlan> {
  const scenes = new Map<string, WhiteModelScenePlan>();
  const previews = new Map<string, WhiteModelScenePlan>();
  const aliases = new Map<string, string>();
  for (const action of actions) {
    const rawKey = action.args["nodeKey"];
    if (typeof rawKey !== "string") continue;
    const key = aliases.get(rawKey) ?? rawKey;
    if (["canvas.set_prompt", "canvas.set_model", "canvas.move_node"].includes(action.tool)) {
      aliases.set(`$${action.id}`, key);
      continue;
    }
    if (!action.tool.startsWith("blender.")) continue;
    let scene = scenes.get(key) ?? (key.startsWith("$") ? null : getDraft(key)?.plan);
    if (action.tool === "blender.set_scene") scene = parseScene(action.args).scene;
    if (action.tool === "blender.refine_motion") {
      if (!scene) throw new Error("请先设置白模场景，再精修角色动作。");
      scene = applyAgentMotionEdit(scene, action.args);
    }
    if (scene) {
      scenes.set(key, scene);
      if (action.tool === "blender.set_scene" || action.tool === "blender.refine_motion")
        previews.set(action.id, scene);
    }
    aliases.set(`$${action.id}`, key);
  }
  return previews;
}

export function createAgentBlenderTools(host: AgentBlenderHost): AgentTool[] {
  const rendering = new Set<string>();
  const resolveNode = (args: unknown, context: AgentToolContext) => {
    context.signal.throwIfAborted();
    context.assertCurrent();
    return context.resolveNodeKey(v.parse(nodeArgs, args).nodeKey);
  };
  const requireDraft = (nodeKey: string) => {
    const draft = host.getDraft(nodeKey);
    if (!draft) throw new Error("该节点尚未设置白模场景，请先调用 blender.set_scene。");
    return draft;
  };
  const saveScene = async (
    nodeKey: string,
    previous: WhiteModelStudioDraft,
    next: WhiteModelStudioDraft,
    context: AgentToolContext,
  ) => {
    if (rendering.has(nodeKey)) throw new Error("该节点正在渲染白模，请先等待或取消任务。");
    const changed = whiteModelRenderSignature(next) !== whiteModelRenderSignature(previous);
    if (changed && previous.jobId) {
      const job = await getBlenderRender(previous.jobId);
      context.signal.throwIfAborted();
      if (active(job)) throw new Error("旧白模任务仍在渲染，请先在导演台取消后修改。");
    }
    if (
      host.getDraft(nodeKey) !== null &&
      whiteModelRenderSignature(requireDraft(nodeKey)) !== whiteModelRenderSignature(previous)
    )
      throw new Error("白模场景已被修改，请重新读取场景后再操作。");
    if (changed) {
      next.jobId = null;
      delete next.jobInputSignature;
      next.blockingImagePath = null;
      delete next.blockingImageSignature;
    }
    context.signal.throwIfAborted();
    context.assertCurrent();
    await host.setDraft(nodeKey, next);
    return { nodeKey, scene: publicScene(next), changed };
  };
  return [
    {
      name: "blender.get_scene",
      title: "读取白模场景",
      effect: "read",
      description:
        "读取指定图片或视频节点的白模方案；没有方案时返回默认方案。动捕只返回摘要，不返回关节数据或文件路径。",
      inputSchema: nodeInputSchema,
      validate(args) {
        v.parse(nodeArgs, args);
      },
      execute(args, context) {
        const nodeKey = resolveNode(args, context);
        const draft = host.getDraft(nodeKey);
        return Promise.resolve({
          nodeKey,
          exists: draft != null,
          mode: draft?.mode ?? "create",
          scene: publicScene(draft ?? createWhiteModelStudioDraft()),
          jobId: draft?.jobId ?? null,
          capabilities:
            "四种几何体、走位和机位关键帧；人形支持多段姿势过渡、身体/头部旋转、手脚IK和动捕叠加精修。refine_motion保留原始动作，可调整动捕速度和起始时间。",
        });
      },
    },
    {
      name: "blender.set_scene",
      title: "设置白模场景",
      effect: "write",
      description:
        "设置完整的声明式 v2 白模方案，单位米、Z向上、yaw度；只修改方案，不渲染。先读取场景并保留既有对象标识。支持 auto/pose及motionRefinement动作轨道，最多64个对象、每对象256关键帧；已有动捕用refine_motion保留原始片段。",
      inputSchema: sceneInputSchema,
      validate(args) {
        parseScene(args);
      },
      async execute(args, context) {
        const parsed = parseScene(args);
        context.signal.throwIfAborted();
        context.assertCurrent();
        const nodeKey = context.resolveNodeKey(parsed.nodeKey);
        if (rendering.has(nodeKey)) throw new Error("该节点正在渲染白模，请先等待或取消任务。");
        const previous = host.getDraft(nodeKey) ?? createWhiteModelStudioDraft();
        if (previous.plan.objects.some((actor) => actor.motion.kind === "clip")) {
          throw new Error("该场景包含视频动捕；请使用 blender.refine_motion，以保留已有动作片段。");
        }
        const next: WhiteModelStudioDraft = {
          ...previous,
          executablePath: "",
          sourceBlendPath: "",
          mode: "create",
          plan: parsed.scene,
          characterBindings: pruneWhiteModelCharacterBindings(
            previous.characterBindings ?? [],
            parsed.scene.objects,
          ),
        };
        return saveScene(nodeKey, previous, next, context);
      },
    },
    {
      name: "blender.refine_motion",
      title: "精修角色动作",
      effect: "write",
      description:
        "先get_scene读取真实actorId。局部修改一个人形角色，保留其他角色和原始动捕；refinement为完整替换的动作轨道，null清除轨道恢复原动作，省略则保留。关键帧time秒严格递增；pose省略/source跟随原动作，其他为姿势过渡；pelvisOffset单位身高，torsoRotation/headRotation为局部XYZ度。IK targets使用角色局部身高单位坐标：Z上、前方-Y、左侧+X，零点脚下；position手腕/脚踝目标，pole肘膝弯曲方向参考点，weight默认1。省略的向量为0，省略target不约束；用关键帧安排蹲起、挥手、抬腿和身体转向，平滑插值。keyframes可同时改根走位，facing manual时采用yaw；clipPlayback仅用于已有动捕的速度/起始时间/循环。只更新方案，渲染另调用render。",
      inputSchema: motionEditInputSchema,
      validate: (args) => {
        parseAgentMotionEdit(args);
      },
      async execute(args, context) {
        const parsed = parseAgentMotionEdit(args);
        context.signal.throwIfAborted();
        context.assertCurrent();
        const nodeKey = context.resolveNodeKey(parsed.nodeKey);
        const previous = requireDraft(nodeKey);
        if (previous.mode !== "create") throw new Error("请先使用声明式白模场景，再精修角色动作。");
        const plan = applyAgentMotionEdit(previous.plan, parsed);
        return saveScene(nodeKey, previous, { ...previous, plan }, context);
      },
    },
    {
      name: "blender.render",
      title: "渲染并接入白模视频",
      effect: "render",
      description:
        "使用内置 Blender 渲染指定视频节点已保存的方案，复用同一方案的已有任务；完成后把真实本地结果连接到该节点。调用前向用户展示并确认执行计划。支持取消与进度；不接受Python、文件路径或可执行程序。",
      inputSchema: nodeInputSchema,
      validate(args) {
        v.parse(nodeArgs, args);
      },
      async execute(args, context) {
        const nodeKey = resolveNode(args, context);
        if (rendering.has(nodeKey)) throw new Error("该节点已有智能体白模渲染正在执行。");
        rendering.add(nodeKey);
        let job: BlenderRenderJob | null = null;
        let conflict = false;
        let startedHere = false;
        let persisted = false;
        try {
          const draft = structuredClone(requireDraft(nodeKey));
          if (draft.mode !== "create" || draft.executablePath.trim()) {
            throw new Error("智能体仅使用内置引擎渲染声明式白模；外部工程请在白模导演台操作。");
          }
          const issue = whiteModelPlanIssue(draft.plan);
          if (issue) throw new Error(issue);
          const signature = whiteModelRenderSignature(draft);
          const verify = () => {
            context.signal.throwIfAborted();
            try {
              context.assertCurrent();
              if (whiteModelRenderSignature(requireDraft(nodeKey)) === signature) return;
            } catch (error) {
              conflict = true;
              throw error;
            }
            conflict = true;
            throw new Error("白模场景在任务执行期间已改变，旧结果不会写回画布。");
          };
          if (draft.jobId && draft.jobInputSignature === signature) {
            job = await getBlenderRender(draft.jobId);
            verify();
            if (job.status === "failed" || job.status === "cancelled") {
              context.report("上次白模任务已停止，将按本次确认重新渲染。");
              job = null;
            } else {
              context.report("正在复用已有白模任务。");
            }
          }
          if (!job) {
            if (draft.jobId && draft.jobInputSignature !== signature) {
              const oldJob = await getBlenderRender(draft.jobId);
              verify();
              if (active(oldJob)) throw new Error("旧白模任务仍在渲染，请先取消后再提交新方案。");
            }
            verify();
            job = await startBlenderRender(whiteModelRenderRequest(draft));
            startedHere = true;
            verify();
            await host.setDraft(nodeKey, {
              ...draft,
              jobId: job.jobId,
              jobInputSignature: signature,
            });
            persisted = true;
            verify();
          }
          while (active(job)) {
            context.report(`${job.message}（${Math.round(job.progress)}%）`);
            await waitForPoll(context.signal);
            verify();
            job = await getBlenderRender(job.jobId);
            verify();
          }
          if (job.status !== "succeeded" || !job.videoPath) {
            throw new Error(job.error ?? job.message ?? "白模渲染未完成。");
          }
          verify();
          const attached = await host.attachVideo(nodeKey, job);
          context.report("白模视频已完成并连接到画布。");
          return { nodeKey, jobId: job.jobId, status: job.status, attached };
        } catch (error) {
          if (
            job &&
            active(job) &&
            (context.signal.aborted || conflict || (startedHere && !persisted))
          ) {
            try {
              await cancelBlenderRender(job.jobId);
            } catch {
              context.report("停止白模任务失败，可在白模导演台重试取消。");
            }
          }
          throw error;
        } finally {
          rendering.delete(nodeKey);
        }
      },
    },
    {
      name: "blender.open_studio",
      title: "打开白模导演台",
      effect: "read",
      description: "打开指定节点的实时白模导演台，供用户预览、编辑或操作已有动捕与专业工程。",
      inputSchema: nodeInputSchema,
      validate(args) {
        v.parse(nodeArgs, args);
      },
      execute(args, context) {
        const nodeKey = resolveNode(args, context);
        host.openStudio(nodeKey);
        return Promise.resolve({ nodeKey, opened: true });
      },
    },
  ];
}
