import { describe, expect, it } from "vitest";
import { JOINT, JOINT_COUNT, decodeMotionClipJoints, encodeMotionClipJoints } from "./whiteModelScene";
import { landmarksToJoints, normalizeCapturedFrames } from "./poseCapture";

function landmark(x: number, y: number, z: number) {
  return { x, y, z, visibility: 1 };
}

/** MediaPipe 世界坐标：x 右、y 下、z 朝向镜头。构造一个面朝镜头、脚在 y=0 的站立人。 */
function standingLandmarks(offsetX = 0) {
  const points = Array.from({ length: 33 }, () => landmark(0, 0, 0));
  points[0] = landmark(offsetX, -0.7, 0);
  points[7] = landmark(offsetX + 0.08, -0.68, 0);
  points[8] = landmark(offsetX - 0.08, -0.68, 0);
  points[11] = landmark(offsetX + 0.2, -0.5, 0);
  points[12] = landmark(offsetX - 0.2, -0.5, 0);
  points[13] = landmark(offsetX + 0.22, -0.28, 0);
  points[14] = landmark(offsetX - 0.22, -0.28, 0);
  points[15] = landmark(offsetX + 0.22, -0.05, 0);
  points[16] = landmark(offsetX - 0.22, -0.05, 0);
  points[23] = landmark(offsetX + 0.1, -0.05, 0);
  points[24] = landmark(offsetX - 0.1, -0.05, 0);
  points[25] = landmark(offsetX + 0.1, 0.35, 0);
  points[26] = landmark(offsetX - 0.1, 0.35, 0);
  points[27] = landmark(offsetX + 0.1, 0.75, 0);
  points[28] = landmark(offsetX - 0.1, 0.75, 0);
  return points;
}

function joint(frame: Float32Array | Float64Array, index: number, axis: 0 | 1 | 2) {
  return frame[index * 3 + axis]!;
}

describe("一键动捕归一化", () => {
  it("把 MediaPipe 33 点换成 17 关节，并转到 Z 向上", () => {
    const joints = landmarksToJoints(standingLandmarks());
    expect(joints).toHaveLength(JOINT_COUNT * 3);
    expect(joint(joints, JOINT.head, 2)).toBeGreaterThan(joint(joints, JOINT.pelvis, 2));
    expect(joint(joints, JOINT.leftAnkle, 2)).toBeLessThan(joint(joints, JOINT.head, 2));
    expect(joint(joints, JOINT.nose, 2)).toBeCloseTo(0.7, 5);
  });

  it("补齐漏检、统一面向 -Y、缩放到单位身高且脚落在地面", () => {
    const present = landmarksToJoints(standingLandmarks(0.4));
    const normalized = normalizeCapturedFrames([present, null, present]);
    expect(normalized.length).toBe(3 * JOINT_COUNT * 3);
    const first = normalized.subarray(0, JOINT_COUNT * 3);
    expect(joint(first, JOINT.leftShoulder, 0)).toBeGreaterThan(joint(first, JOINT.rightShoulder, 0));
    expect(Math.min(joint(first, JOINT.leftAnkle, 2), joint(first, JOINT.rightAnkle, 2))).toBeCloseTo(
      0.045,
      2,
    );
    const height = joint(first, JOINT.head, 2) - Math.min(joint(first, JOINT.leftAnkle, 2), joint(first, JOINT.rightAnkle, 2));
    expect(height).toBeGreaterThan(0.8);
    expect(height).toBeLessThan(1.05);
    const encoded = decodeMotionClipJoints(encodeMotionClipJoints(normalized), 3);
    expect(encoded.length).toBe(normalized.length);
  });
});
