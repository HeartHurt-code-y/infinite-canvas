/** The eight fixed-price SP 2.5 gateway models use a contract distinct from Seedance. */
export interface PerTaskVideoProfile {
  readonly modelId: string;
  readonly minimumDuration: number;
  readonly maximumDuration: number;
  readonly maxImages: number;
  readonly maxAudios: number;
}

const MODELS: Readonly<Record<string, Omit<PerTaskVideoProfile, "modelId">>> = {
  "sp2.5-720p-4-15s": { minimumDuration: 4, maximumDuration: 15, maxImages: 10, maxAudios: 0 },
  "sp2.5-720p-16-30s": { minimumDuration: 16, maximumDuration: 30, maxImages: 10, maxAudios: 0 },
  "sp2.5-720p-30s-ch1": { minimumDuration: 30, maximumDuration: 30, maxImages: 30, maxAudios: 0 },
  "sp2.5-720p-30s-ch2": { minimumDuration: 30, maximumDuration: 30, maxImages: 9, maxAudios: 0 },
  "sp2.5-720p-30s-ch3": { minimumDuration: 30, maximumDuration: 30, maxImages: 30, maxAudios: 0 },
  "sp2.5-720p-30s-ch4": { minimumDuration: 30, maximumDuration: 30, maxImages: 9, maxAudios: 0 },
  "sp2.5-720p-30s-ch5": { minimumDuration: 30, maximumDuration: 30, maxImages: 10, maxAudios: 10 },
  "sp2.5-720p-30s-ch6": { minimumDuration: 30, maximumDuration: 30, maxImages: 30, maxAudios: 10 },
};

export function perTaskVideoProfile(modelId: string): PerTaskVideoProfile | null {
  const profile = MODELS[modelId];
  return profile ? { modelId, ...profile } : null;
}

/** Public image/audio URLs are separate from Wan's document and webpage URL inputs. */
export interface PerTaskVideoUrlInput {
  readonly id: string;
  readonly kind: "image" | "audio";
  readonly url: string;
}

function isNonPublicLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return !/^[23][0-9a-f]/.test(host); // public IPv6 unicast
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return false;
  const [first = 0, second = 0] = host.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

export function perTaskVideoUrlIssue(inputs: readonly PerTaskVideoUrlInput[]): string | null {
  const ids = new Set<string>();
  for (const input of inputs) {
    if (typeof input.id !== "string" || !input.id || ids.has(input.id))
      return "参考 URL 标识重复或缺失，请移除后重新添加。";
    ids.add(input.id);
    if (input.kind !== "image" && input.kind !== "audio")
      return "按次视频 URL 仅支持参考图片或参考音频。";
    if (typeof input.url !== "string" || !input.url.trim()) return "参考 URL 不能为空。";
    try {
      const parsed = new URL(input.url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        isNonPublicLiteralHost(parsed.hostname)
      )
        return "参考素材必须使用无需账号密码的公网 http(s) URL。";
    } catch {
      return "参考素材必须使用有效的公网 http(s) URL。";
    }
  }
  return null;
}

export function perTaskVideoUrlConnection(input: PerTaskVideoUrlInput) {
  const key = `sp-url:${input.id}`;
  return {
    key,
    name: input.kind === "image" ? "参考图 URL" : "参考音频 URL",
    kind: input.kind,
    target: {
      kind: "url" as const,
      url: input.url.trim(),
      mediaType: input.kind,
      canvasNodeKey: key,
    },
    role: input.kind === "image" ? "reference_image" : "reference_audio",
  };
}
