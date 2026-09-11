import { describe, expect, it } from "vitest";
import type { StagingJobRecord, StagingStatus } from "../../lib/backend";
import {
  UPLOAD_ABANDONED_MS,
  isTerminalAssetUpload,
  isTerminalStagingJob,
  mergeStagingJobsIntoUploads,
  shouldAutoDismissUpload,
  stagingImportReachedLibrary,
  type AssetUploadEntry,
  textResultFromSource,
} from "./workspaceModel";

function uploadEntry(overrides: Partial<AssetUploadEntry> = {}): AssetUploadEntry {
  return {
    jobId: "job-1",
    name: "素材.png",
    kind: "image",
    assetId: null,
    status: "importing",
    bytesUploaded: 2048,
    bytesTotal: 2048,
    error: null,
    lastAdvancedAt: 1_000,
    stalled: false,
    destination: "cloud",
    adjustment: null,
    ...overrides,
  };
}

function stagingJob(overrides: Partial<StagingJobRecord> = {}): StagingJobRecord {
  return {
    id: "job-1",
    localPath: "C:\\media\\素材.png",
    purpose: "asset_import",
    mediaType: "image",
    objectKey: "staging/素材.png",
    status: "importing",
    bytesTotal: 2048,
    bytesUploaded: 2048,
    assetId: null,
    importTarget: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("mergeStagingJobsIntoUploads", () => {
  it("后端记录长时间无任何推进时落地为已中断并带上原因（僵尸在途行）", () => {
    // 真实场景：导入阶段后端进程退出，记录永远停在 importing，
    // 前端此前会一直转圈，而且非终态行不给关闭按钮。
    const entry = uploadEntry({ status: "importing", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "importing" })],
      120_000,
    );
    expect(merged).not.toBeNull();
    const row = merged![0]!;
    expect(row.status).toBe("interrupted");
    expect(row.stalled).toBe(false);
    expect(row.error).toMatchObject({ kind: "abandoned", lastBackendStatus: "importing" });
    expect(String((row.error as { message: string }).message)).toContain("进程已经不在");
  });

  it("尚未超时的在途行照常刷新，不误判为中断", () => {
    const entry = uploadEntry({ status: "importing", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "importing" })],
      119_999,
    );
    // importing 不是实时跟踪阶段且数据未变：整批无变化，返回 null 让调用方跳过重渲染。
    expect(merged).toBeNull();
  });

  it.each(["staged", "importing", "cleaning"] as const)(
    "真机上卡住的 %s 行（字节与状态都不再变）也会被落地为已中断",
    (status) => {
      // 回归：导入阶段的特征就是「字节不再变、状态也不变」，此前"无变化就跳过"的
      // 提前返回排在僵尸判定之前，判定永远执行不到——用户看到的行一直转圈。
      const entry = uploadEntry({ status, lastAdvancedAt: 0 });
      const merged = mergeStagingJobsIntoUploads([entry], [stagingJob({ status })], 600_000);
      expect(merged).not.toBeNull();
      expect(merged![0]!.status).toBe("interrupted");
      expect(merged![0]!.error).toMatchObject({ kind: "abandoned", lastBackendStatus: status });
    },
  );

  it("后端任务记录本身没有任何变化，也不影响僵尸判定", () => {
    // 最严苛的形态：行与后端记录逐字段相同（bytesTotal/bytesUploaded 都一致），
    // 唯一支撑判定的就是时间。
    const entry = uploadEntry({ status: "staged", bytesUploaded: 38532482, lastAdvancedAt: 0 });
    const job = stagingJob({ status: "staged", bytesUploaded: 38532482, bytesTotal: 38532482 });
    expect(mergeStagingJobsIntoUploads([entry], [job], 60_000)).toBeNull();
    const merged = mergeStagingJobsIntoUploads([entry], [job], 120_000);
    expect(merged![0]!.status).toBe("interrupted");
  });

  it("字节仍在推进时不吃僵尸判定，并按推进刷新 lastAdvancedAt", () => {
    const entry = uploadEntry({ status: "uploading", bytesUploaded: 1024, lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "uploading", bytesUploaded: 4096 })],
      500_000,
    );
    expect(merged![0]).toMatchObject({ status: "uploading", bytesUploaded: 4096 });
    expect(merged![0]!.lastAdvancedAt).toBe(500_000);
    expect(merged![0]!.error).toBeNull();
  });

  it("后端已到终态时照实写入，不被僵尸判定改写", () => {
    const entry = uploadEntry({ status: "uploading", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "failed", error: { kind: "transport", message: "连接中断" } })],
      500_000,
    );
    expect(merged![0]).toMatchObject({ status: "failed" });
    expect(merged![0]!.error).toEqual({ kind: "transport", message: "连接中断" });
  });

  it("已经拿到素材身份的 cleaning 记录不会被判成僵尸，并把素材身份写回行上", () => {
    // 真实场景：素材已经入库，后端随后清理暂存对象时请求失败（或进程在清理途中退出），
    // 记录永久停在 cleaning。它长时间不会有任何推进，但它是成功，不是「执行者已经没了」。
    const entry = uploadEntry({ status: "importing", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "cleaning", assetId: "asset-42", updatedAt: 1 })],
      600_000,
    );
    expect(merged).not.toBeNull();
    const row = merged![0]!;
    expect(row.status).toBe("cleaning");
    expect(row.assetId).toBe("asset-42");
    expect(row.error).toBeNull();
    expect(isTerminalAssetUpload(row)).toBe(true);
  });

  it("没有素材身份的 cleaning 记录仍按僵尸口径落地为已中断", () => {
    // 导入失败后清场停在同一状态：没有 assetId 就不是成功，不能给它亮绿点。
    const entry = uploadEntry({ status: "cleaning", lastAdvancedAt: 0 });
    const merged = mergeStagingJobsIntoUploads(
      [entry],
      [stagingJob({ status: "cleaning", assetId: null })],
      120_000,
    );
    expect(merged![0]!.status).toBe("interrupted");
  });

  it("占位行在后端还没有任务记录时只推进停滞提示", () => {
    const entry = uploadEntry({ status: "uploading", lastAdvancedAt: 0, stalled: false });
    const merged = mergeStagingJobsIntoUploads([entry], [null], 20_000);
    expect(merged![0]!.stalled).toBe(true);
    expect(merged![0]!.status).toBe("uploading");
  });

  it("已经是终态的行不再参与合并", () => {
    const entry = uploadEntry({ status: "interrupted", lastAdvancedAt: 0 });
    expect(mergeStagingJobsIntoUploads([entry], [null], 900_000)).toBeNull();
  });

  it("哨兵时间戳（epoch）不被当成僵尸，避免刚提交的上传立刻变成已中断", () => {
    // 后端记录缺 updated_at 时前端回填 0/1；若只看差值，任何"当前时间"都会超出窗口，
    // 一条正常的上传会被立刻判成已中断。
    const now = 1_800_000_000_000;
    const fresh = uploadEntry({ status: "uploading", lastAdvancedAt: 1, bytesUploaded: 0 });
    const freshMerged = mergeStagingJobsIntoUploads(
      [fresh],
      [stagingJob({ status: "uploading" })],
      now,
    );
    // uploading 是实时跟踪阶段：合并会刷新行的展示，但绝不能把状态改写成 interrupted。
    expect(freshMerged![0]!.status).toBe("uploading");
    expect(freshMerged![0]!.error).toBeNull();

    // 同一时刻，真实只停滞了两分钟的上传才该落地为已中断。
    const idle = uploadEntry({
      status: "uploading",
      lastAdvancedAt: now - UPLOAD_ABANDONED_MS - 1,
      bytesUploaded: 0,
    });
    const merged = mergeStagingJobsIntoUploads(
      [idle],
      [stagingJob({ status: "uploading", bytesUploaded: 0 })],
      now,
    );
    expect(merged![0]!.status).toBe("interrupted");
  });
});

describe("shouldAutoDismissUpload", () => {
  it("只有成功收尾的上传自动收起", () => {
    // 成功：素材库已给出素材身份。
    expect(shouldAutoDismissUpload({ status: "active", assetId: "asset-42" })).toBe(true);
    expect(shouldAutoDismissUpload({ status: "cleaned", assetId: "asset-42" })).toBe(true);
    // 清理暂存对象没走完（清理请求失败/进程退出）同样已经入库成功，记录会永久停在
    // cleaning：按状态判定会把它当成没完成，按素材身份判定才对。
    expect(shouldAutoDismissUpload({ status: "cleaning", assetId: "asset-42" })).toBe(true);
  });

  it("失败与中断永不自动收起：用户要看原因并重试", () => {
    expect(shouldAutoDismissUpload({ status: "failed", assetId: null })).toBe(false);
    expect(shouldAutoDismissUpload({ status: "interrupted", assetId: null })).toBe(false);
  });

  it("未完成的阶段都不算成功", () => {
    for (const status of [
      "validating",
      "authorizing",
      "uploading",
      "staged",
      "importing",
      "cleaning",
    ] satisfies StagingStatus[]) {
      expect(shouldAutoDismissUpload({ status, assetId: null })).toBe(false);
    }
  });

  it("没有素材身份时即使状态像成功也不算成功（导入失败后的清场记录）", () => {
    // 后端报失败前会先尽力删掉暂存对象，那条记录同样经过 cleaning/cleaned，
    // 但它没有 assetId：认定为成功会让失败的上传亮绿点、还停止轮询。
    expect(shouldAutoDismissUpload({ status: "cleaning", assetId: null })).toBe(false);
    expect(shouldAutoDismissUpload({ status: "cleaned", assetId: null })).toBe(false);
    expect(shouldAutoDismissUpload({ status: "active", assetId: "" })).toBe(false);
  });
});

describe("stagingImportReachedLibrary / isTerminalStagingJob", () => {
  it("拿到素材身份就是成功，不管随后清理到哪一步", () => {
    for (const status of ["active", "cleaning", "cleaned"] satisfies StagingStatus[]) {
      expect(stagingImportReachedLibrary({ status, assetId: "asset-42" })).toBe(true);
      expect(isTerminalStagingJob({ status, assetId: "asset-42" })).toBe(true);
    }
  });

  it("还没拿到素材身份就不算成功，也不停止跟踪", () => {
    for (const status of ["staged", "importing", "cleaning", "cleaned"] satisfies StagingStatus[]) {
      expect(stagingImportReachedLibrary({ status, assetId: null })).toBe(false);
      expect(isTerminalStagingJob({ status, assetId: null })).toBe(false);
    }
    expect(isTerminalStagingJob({ status: "failed", assetId: null })).toBe(true);
    expect(isTerminalStagingJob({ status: "interrupted", assetId: null })).toBe(true);
  });
});

describe("textResultFromSource", () => {
  it("extracts Context-IR 扩写正文 from source { kind: 'text', text }", () => {
    expect(textResultFromSource({ kind: "text", text: "  扩写后的完整提示词  " })).toBe(
      "扩写后的完整提示词",
    );
  });

  it("returns null for media sources or empty text", () => {
    expect(textResultFromSource({ kind: "url", url: "https://x" })).toBeNull();
    expect(textResultFromSource({ kind: "text", text: "   " })).toBeNull();
    expect(textResultFromSource(null)).toBeNull();
    expect(textResultFromSource(undefined)).toBeNull();
    expect(textResultFromSource("plain string")).toBeNull();
  });
});
