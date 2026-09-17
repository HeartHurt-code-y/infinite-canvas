import type { IconName } from "../../components/Icon";

export type CanvasQuickAddKind =
  | "asset_upload"
  | "image"
  | "video"
  | "video_composer"
  | "video_downloader"
  | "frame_extractor"
  | "viral_remix"
  | "prompt"
  | "screenplay"
  | "storyboard";

/** Canvas creation menu: upload local media, then reusable node templates. */
export const CANVAS_QUICK_ADD_CHOICES: readonly {
  readonly kind: CanvasQuickAddKind;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { kind: "asset_upload", label: "上传素材", icon: "upload-simple" },
  { kind: "image", label: "图片生成", icon: "image" },
  { kind: "video", label: "视频生成", icon: "video-camera" },
  { kind: "video_composer", label: "视频拼接与合成", icon: "film-strip" },
  { kind: "video_downloader", label: "网络爆款视频下载", icon: "download-simple" },
  { kind: "frame_extractor", label: "视频抽帧", icon: "folder-open" },
  { kind: "viral_remix", label: "爆款视频复刻", icon: "film-strip" },
  { kind: "prompt", label: "提示词生成与优化", icon: "magic-wand" },
  { kind: "screenplay", label: "剧本创作与优化", icon: "book-open-text" },
  { kind: "storyboard", label: "剧本转工业级分镜脚本", icon: "film-slate" },
];
