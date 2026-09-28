import type {
  ReelbenchShot,
  ReelbenchShotDraft,
  ReelbenchValidation,
  ReelbenchWorkflowOptions,
} from "./reelbenchWorkflowModel";

function html(value: string | number | null | undefined): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function markdown(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function localImagePath(outputDir: string, imagePath: string): string | null {
  const root = outputDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const image = imagePath.replaceAll("\\", "/");
  if (!image.startsWith(`${root}/`)) return null;
  return image
    .slice(root.length + 1)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

const LABELS = {
  zh: {
    title: "拉片分析报告",
    source: "原片",
    duration: "时长",
    frames: "镜头",
    average: "平均镜长",
    pace: "每分钟切次",
    quality: "质量检查",
    hints: "提示",
    table: "镜头表",
    search: "搜索镜号、画面或文字",
    choose: "选择原片以同步播放",
    id: "镜号",
    time: "时间",
    size: "景别",
    category: "类别",
    camera: "运镜",
    frame: "画面",
    audio: "可见字幕 / 台词",
    rhythm: "节奏",
    motion: "实测运动",
    images: "首尾帧",
    shot: "镜头",
    local: "报告只读取本地文件，不连接外部网站。",
  },
  en: {
    title: "Shot analysis report",
    source: "Source video",
    duration: "Duration",
    frames: "Shots",
    average: "Average shot",
    pace: "Cuts per minute",
    quality: "Quality checks",
    hints: "Hints",
    table: "Shot table",
    search: "Search shots and descriptions",
    choose: "Choose source video for synced playback",
    id: "Shot",
    time: "Time",
    size: "Size",
    category: "Category",
    camera: "Camera",
    frame: "Frame",
    audio: "Visible subtitles / dialogue",
    rhythm: "Rhythm",
    motion: "Measured motion",
    images: "Opening / ending frames",
    shot: "Shot",
    local: "This report reads local files only and makes no external requests.",
  },
} as const;

function rhythm(shot: ReelbenchShot): string {
  return [shot.rhythm, shot.rhythmNote].filter(Boolean).join(" · ");
}

export function reelbenchReportMarkdown(
  draft: ReelbenchShotDraft,
  validation: ReelbenchValidation,
  language: ReelbenchWorkflowOptions["language"],
): string {
  const label = LABELS[language];
  const average = draft.shots.length ? draft.meta.durationSeconds / draft.shots.length : 0;
  const pace =
    draft.meta.durationSeconds > 0
      ? ((draft.shots.length - 1) * 60) / draft.meta.durationSeconds
      : 0;
  const lines = [
    `# ${label.title}`,
    "",
    `${label.source}: ${draft.videoPath}`,
    `${label.duration}: ${draft.meta.durationSeconds.toFixed(2)} s · ${draft.meta.width} × ${draft.meta.height} · ${draft.meta.fps.toFixed(2)} fps`,
    `${label.frames}: ${draft.shots.length} · ${label.average}: ${average.toFixed(2)} s · ${label.pace}: ${pace.toFixed(1)}`,
    "",
    `## ${label.quality}`,
    "",
    ...validation.gates.map(
      (gate) =>
        `- ${gate.skipped ? "—" : gate.ok ? "✓" : "✗"} ${gate.id}${gate.issues.length ? `: ${gate.issues.join("; ")}` : ""}`,
    ),
    ...validation.hints.map((hint) => `- ${label.hints}: ${hint}`),
    "",
    `## ${label.table}`,
    "",
    `| ${label.id} | ${label.time} | ${label.size} | ${label.category} | ${label.camera} | ${label.frame} | ${label.audio} | ${label.rhythm} |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...draft.shots.map(
      (shot) =>
        `| ${markdown(shot.id)} | ${shot.start.toFixed(2)}–${shot.end.toFixed(2)} s | ${markdown(shot.size)} | ${markdown(shot.category)} | ${markdown(shot.camera)} | ${markdown(shot.frame)} | ${markdown(shot.audio)} | ${markdown(rhythm(shot))} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function reelbenchReportHtml(
  draft: ReelbenchShotDraft,
  validation: ReelbenchValidation,
  language: ReelbenchWorkflowOptions["language"],
): string {
  const label = LABELS[language];
  const average = draft.shots.length ? draft.meta.durationSeconds / draft.shots.length : 0;
  const pace =
    draft.meta.durationSeconds > 0
      ? ((draft.shots.length - 1) * 60) / draft.meta.durationSeconds
      : 0;
  const rows = draft.shots
    .map((shot) => {
      const a = localImagePath(draft.outputDir, shot.frameAPath);
      const b = localImagePath(draft.outputDir, shot.frameBPath);
      return `<tr data-start="${shot.start}" data-end="${shot.end}"><th>${html(shot.id)}</th><td>${shot.start.toFixed(2)}–${shot.end.toFixed(2)} s<br>${shot.seconds.toFixed(2)} s</td><td>${html(shot.size)}</td><td>${html(shot.category)}</td><td>${html(shot.camera)}</td><td>${html(shot.frame)}</td><td>${html(shot.audio)}</td><td>${html(rhythm(shot))}</td><td>${shot.motion == null ? "—" : shot.motion.toFixed(3)}</td><td class="frames">${a ? `<img loading="lazy" src="${html(a)}" alt="${html(shot.id)} a">` : ""}${b ? `<img loading="lazy" src="${html(b)}" alt="${html(shot.id)} b">` : ""}</td></tr>`;
    })
    .join("\n");
  const gates = validation.gates
    .map(
      (gate) =>
        `<li class="${gate.ok ? "pass" : "fail"}">${html(gate.id)}: ${html(gate.skipped ? "skipped" : gate.ok ? "pass" : gate.issues.join("; "))}</li>`,
    )
    .join("");
  const hints = validation.hints.map((hint) => `<li>${html(hint)}</li>`).join("");
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(label.title)}</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0b1117;color:#e8edf2}
*{box-sizing:border-box}body{margin:0 auto;max-width:1500px;padding:24px}h1,h2{letter-spacing:.01em}p{line-height:1.5;color:#aebbc9}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.card,details,.viewer{background:#14202b;border:1px solid #324356;border-radius:12px;padding:14px}
.card strong{display:block;font-size:1.4rem;color:#f5fbff}.card span{color:#aebbc9}details{margin:14px 0}summary{cursor:pointer;font-weight:650}
video{width:min(100%,900px);max-height:60vh;background:#000;border-radius:8px;margin:10px 0}input{font:inherit;color:inherit;background:#12202b;border:1px solid #5c7186;border-radius:7px;padding:9px}
input[type=search]{width:min(100%,430px);margin:12px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1050px}th,td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid #2b3b4b;font-size:.89rem}thead th{position:sticky;top:0;background:#1d2c3b}tbody tr{cursor:pointer}tbody tr:hover,tbody tr.active{background:#22435a}.frames{min-width:210px}.frames img{display:inline-block;width:98px;max-height:100px;object-fit:contain;background:#05080b;margin:2px}.pass{color:#9de5b1}.fail{color:#ffaaa3}li{margin:5px 0}
</style></head><body>
<h1>${html(label.title)}</h1><p>${html(label.local)}</p>
<div class="cards"><div class="card"><strong>${draft.shots.length}</strong><span>${html(label.frames)}</span></div><div class="card"><strong>${draft.meta.durationSeconds.toFixed(2)} s</strong><span>${html(label.duration)}</span></div><div class="card"><strong>${average.toFixed(2)} s</strong><span>${html(label.average)}</span></div><div class="card"><strong>${pace.toFixed(1)}</strong><span>${html(label.pace)}</span></div></div>
<section class="viewer"><label>${html(label.choose)} <input id="video-file" type="file" accept="video/*"></label><video id="player" controls preload="metadata"></video></section>
<details><summary>${html(label.quality)} · ${validation.gates.filter((gate) => gate.ok).length}/${validation.gates.length}</summary><ul>${gates}</ul>${hints ? `<h3>${html(label.hints)}</h3><ul>${hints}</ul>` : ""}</details>
<h2>${html(label.table)}</h2><input id="search" type="search" placeholder="${html(label.search)}" aria-label="${html(label.search)}">
<div class="table-wrap"><table><thead><tr><th>${html(label.id)}</th><th>${html(label.time)}</th><th>${html(label.size)}</th><th>${html(label.category)}</th><th>${html(label.camera)}</th><th>${html(label.frame)}</th><th>${html(label.audio)}</th><th>${html(label.rhythm)}</th><th>${html(label.motion)}</th><th>${html(label.images)}</th></tr></thead><tbody>${rows}</tbody></table></div>
<script>
const player=document.getElementById('player'), file=document.getElementById('video-file'), search=document.getElementById('search'), rows=[...document.querySelectorAll('tbody tr')];let objectUrl=null;
file.addEventListener('change',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);const video=file.files&&file.files[0];objectUrl=video?URL.createObjectURL(video):null;player.src=objectUrl||'';});
search.addEventListener('input',()=>{const query=search.value.trim().toLowerCase();for(const row of rows)row.hidden=!!query&&!row.textContent.toLowerCase().includes(query);});
for(const row of rows)row.addEventListener('click',()=>{if(!player.src)return;player.currentTime=Number(row.dataset.start);player.play().catch(()=>{});});
player.addEventListener('timeupdate',()=>{const time=player.currentTime;let active=null;for(const row of rows){if(time>=Number(row.dataset.start)&&time<Number(row.dataset.end)){active=row;break;}}for(const row of rows)row.classList.toggle('active',row===active);});
window.addEventListener('pagehide',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);});
</script></body></html>`;
}

export async function writeReelbenchReports(
  draft: ReelbenchShotDraft,
  validation: ReelbenchValidation,
  language: ReelbenchWorkflowOptions["language"],
): Promise<{ reportJsonPath: string; reportMarkdownPath: string; reportHtmlPath: string }> {
  const [{ writeTextFile }, { join }] = await Promise.all([
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const reportJsonPath = await join(draft.outputDir, "shots.json");
  const reportMarkdownPath = await join(draft.outputDir, "shots.md");
  const reportHtmlPath = await join(draft.outputDir, "shots-report.html");
  await writeTextFile(
    reportJsonPath,
    JSON.stringify({ schemaVersion: "shot-analysis.v1", ...draft, validation }, null, 2),
  );
  await writeTextFile(reportMarkdownPath, reelbenchReportMarkdown(draft, validation, language));
  await writeTextFile(reportHtmlPath, reelbenchReportHtml(draft, validation, language));
  return { reportJsonPath, reportMarkdownPath, reportHtmlPath };
}
