export const directorProps = [
  ["cube", "立方体"], ["sphere", "球体"], ["cylinder", "圆柱体"], ["torus", "环状体"], ["cone", "圆锥"], ["pyramid", "棱锥"],
  ["chair", "椅子"], ["sofa", "沙发"], ["square_table", "方桌"], ["round_table", "圆桌"],
  ["wall_2m", "墙段 2m"], ["wall_3m", "墙段 3m"], ["column", "柱子"], ["staircase", "楼梯段"],
  ["tree_small", "小树"], ["tree_large", "大树"], ["rock", "石头"], ["bush", "灌木"],
  ["car", "轿车"], ["bicycle", "自行车"], ["streetlamp", "路灯"], ["bench", "长椅"], ["trash_bin", "垃圾桶"],
  ["arrow", "方向箭头"], ["area_marker", "区域标记"], ["image_board", "图片板"],
] as const;
export type DirectorPropKind = (typeof directorProps)[number][0];

export const directorBodies = [
  ["character", "标准男性"], ["female", "标准女性"], ["child", "儿童素体"], ["chibi", "Q版素体"],
] as const;
export type DirectorBody = (typeof directorBodies)[number][0];

export function isDirectorBody(kind: string): kind is DirectorBody {
  return directorBodies.some(([value]) => value === kind);
}

type Vector = [number, number, number];
export const directorCameras: readonly (readonly [string, Vector, Vector, number])[] = [
  ["正面中景", [0, 1.5, 4], [0, 1.2, 0], 50],
  ["正面特写", [0, 1.7, 2], [0, 1.6, 0], 35],
  ["正面全景", [0, 2.5, 8], [0, 1, 0], 60],
  ["侧面跟拍", [4, 1.5, 0], [0, 1.2, 0], 50],
  ["侧面近景", [2.5, 1.5, 0], [0, 1.5, 0], 40],
  ["背面中景", [0, 1.5, -4], [0, 1.2, 0], 50],
  ["顶部全景", [0, 8, 3], [0, 0, 0], 55],
  ["45° 俯拍", [0, 5, 5], [0, 1, 0], 50],
  ["低机位仰拍", [0, 0.3, 3], [0, 1.3, 0], 45],
];

export function directorLookAt(position: Vector, target: Vector): Vector {
  const x = target[0] - position[0];
  const y = target[1] - position[1];
  const z = target[2] - position[2];
  if (x === 0 && y === 0 && z === 0) return [0, 0, 0];
  const degrees = 180 / Math.PI;
  return [Math.atan2(y, Math.hypot(x, z)) * degrees, Math.atan2(-x, -z) * degrees, 0];
}
