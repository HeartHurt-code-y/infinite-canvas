import * as v from "valibot";
import { whiteModelPlanIssue, type WhiteModelScenePlan } from "../../../lib/whiteModelScene";
import {
  whiteModelMotionRefinementSchema,
  parseWhiteModelMotionRefinement,
} from "../../../lib/whiteModelMotionRefinement";

const number = (min: number, max: number) =>
  v.pipe(v.number(), v.finite(), v.minValue(min), v.maxValue(max));
const id = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(160),
  v.check((s) => !!s.trim()),
);
const vector = v.tuple([number(-100, 100), number(-100, 100), number(-100, 100)]);
const motionEditSchema = v.pipe(
  v.strictObject({
    nodeKey: id,
    actorId: id,
    refinement: v.optional(v.nullable(whiteModelMotionRefinementSchema)),
    keyframes: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            time: number(0, 30),
            position: vector,
            yaw: v.pipe(v.number(), v.finite()),
          }),
        ),
        v.minLength(1),
        v.maxLength(256),
      ),
    ),
    facing: v.optional(v.picklist(["path", "manual"])),
    clipPlayback: v.optional(
      v.strictObject({
        startTime: number(0, 30),
        speed: number(0.1, 4),
        loop: v.boolean(),
      }),
    ),
  }),
  v.check(
    (args) =>
      [args.refinement, args.keyframes, args.facing, args.clipPlayback].some(
        (value) => value !== undefined,
      ),
    "请提供需要精修的动作、走位或播放设置。",
  ),
);

export function parseAgentMotionEdit(value: unknown) {
  const args = v.parse(motionEditSchema, value);
  if (args.refinement) parseWhiteModelMotionRefinement(args.refinement, 30);
  return args;
}

/** A pure edit: the source motion/clip and all other actors remain intact. */
export function applyAgentMotionEdit(
  plan: WhiteModelScenePlan,
  value: unknown,
): WhiteModelScenePlan {
  const args = parseAgentMotionEdit(value);
  const source = plan.objects.find((actor) => actor.id === args.actorId);
  if (!source) throw new Error("找不到要精修的角色，请先读取白模场景并使用真实角色标识。");
  if (source.shape !== "person") throw new Error("动作精修仅适用于人形角色。");
  const actor = { ...source };
  if (args.refinement === null) delete actor.motionRefinement;
  else if (args.refinement)
    actor.motionRefinement = parseWhiteModelMotionRefinement(args.refinement, plan.durationSeconds);
  if (args.keyframes) actor.keyframes = args.keyframes;
  if (args.facing) actor.facing = args.facing;
  if (args.clipPlayback) {
    if (source.motion.kind !== "clip")
      throw new Error("该角色没有动捕片段，无法修改动捕播放设置。");
    if (args.clipPlayback.startTime > plan.durationSeconds)
      throw new Error("动捕开始时间不能超过场景时长。");
    actor.motion = { ...source.motion, ...args.clipPlayback };
  }
  const result = {
    ...plan,
    objects: plan.objects.map((item) => (item.id === actor.id ? actor : item)),
  };
  const issue = whiteModelPlanIssue(result);
  if (issue) throw new Error(issue);
  return result;
}

const numeric = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const vecSchema = (bound: number) => ({
  type: "array",
  items: numeric(-bound, bound),
  minItems: 3,
  maxItems: 3,
});
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const target = object({ position: vecSchema(4), pole: vecSchema(4), weight: numeric(0, 1) }, [
  "position",
]);
export const motionRefinementInputSchema = object(
  {
    interpolation: { type: "string", enum: ["linear", "smooth"] },
    keyframes: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: object(
        {
          time: numeric(0, 30),
          pose: {
            type: "string",
            enum: ["source", "stand", "sit", "kneel", "crouch", "reach", "arms_up"],
          },
          pelvisOffset: vecSchema(2),
          torsoRotation: vecSchema(180),
          headRotation: vecSchema(180),
          targets: object(
            { leftHand: target, rightHand: target, leftFoot: target, rightFoot: target },
            [],
          ),
        },
        ["time"],
      ),
    },
  },
  ["keyframes"],
);
export const motionEditInputSchema = object(
  {
    nodeKey: { type: "string", minLength: 1, maxLength: 160 },
    actorId: { type: "string", minLength: 1, maxLength: 160 },
    refinement: { anyOf: [{ type: "null" }, motionRefinementInputSchema] },
    keyframes: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: object({ time: numeric(0, 30), position: vecSchema(100), yaw: { type: "number" } }),
    },
    facing: { type: "string", enum: ["path", "manual"] },
    clipPlayback: object({
      startTime: numeric(0, 30),
      speed: numeric(0.1, 4),
      loop: { type: "boolean" },
    }),
  },
  ["nodeKey", "actorId"],
);
