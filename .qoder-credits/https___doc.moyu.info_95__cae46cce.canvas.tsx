import {
  BarChart,
  Callout,
  ChartComparisonGrid,
  ChartContainer,
  H1,
  LineChart,
  MetricsGrid,
  PieChart,
  ReportSection,
  ReportShell,
  Stack,
  Table,
  Text,
  type MetricItem,
} from "qoder/canvas";

// —— 报告数据契约（由 scripts/lib/breakdown.mjs 产出，plugin 注入）——
interface CatRow {
  key: string;
  label: string;
  tokens: number;
  share: number;
}
interface ToolRow {
  tool: string;
  tokens: number;
  calls: number;
  /** 平均每次调用带来的重发 token；无调用记录时 null（不给 0） */
  perCall?: number | null;
  share: number;
}
interface FileRow {
  attr: string;
  label: string;
  kind: string;
  tool: string | null;
  selfTokens: number;
  reads: number;
  trips: number;
  billed: number;
  /** 单次读取的总代价（含此后每一程重发）；reads=0 时 null */
  perRead?: number | null;
  share: number;
}
interface ReqRow {
  index: number;
  time: string | null;
  ratio: number;
  inputTokens: number;
  /** 代理或转录任一有真值即非 null；两者都没则 null（不写 0） */
  outputTokens?: number | null;
  /** proxy=代理实测 / transcript-tokens=转录 input_tokens / transcript-ratio=转录 ratio×window */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "transcript";
  credits: number;
  originalCredits: number;
  afterCompact: boolean;
}
interface CatChild {
  tool: string | null;
  label: string;
  kind: string | null;
  tokens: number;
  share: number;
  catShare: number;
  trips: number;
}
interface CatDetail {
  key: string;
  label: string;
  tokens: number;
  share: number;
  children: CatChild[];
}
interface SubagentRow {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  roundTrips: number;
  billedInputTokens: number;
  peakContextRatio: number;
  credits: number;
  originalCredits: number;
  error: string | null;
}
interface SubagentTotals {
  roundTrips: number;
  billedInputTokens: number;
  credits: number;
  originalCredits: number;
}
interface Subagents {
  scanned: boolean;
  dir: string | null;
  /** 试过的候选目录；用于区分「真没子代理」与「路径没找对」。 */
  probedPaths?: string[];
  /** ok=已汇总 / no-dir=无子代理目录 / dir-empty=目录在但无 agent 文件 / no-usage=有文件但转录无 usage / error=读取抛错 */
  reason?: string;
  count: number;
  items: SubagentRow[];
  totals: SubagentTotals;
  combined: SubagentTotals;
}
/** 逐项可用性：报告里每个数字到底是模型上报的真值、按真值推导、回退默认、手工录入，还是本地根本没有。
 *  v2 旧报告没这个对象，故全部字段可选，读取时一律走默认值（旧报告只可能来自桌面端富转录）。 */
type Avail = "measured" | "derived" | "fallback" | "manual" | "unavailable";
interface Availability {
  credits?: Avail;
  roundTrips?: Avail;
  contextRatio?: Avail;
  tokens?: Avail;
  /** 输出 token：代理或转录 output_tokens 任一有真值即 measured */
  outputTokens?: Avail;
  /** 缓存命中 token：代理或转录 cache_read_input_tokens 任一有真值即 measured */
  cachedTokens?: Avail;
  categoryShare?: Avail;
  toolShare?: Avail;
  fileShare?: Avail;
  systemPrompt?: Avail;
  contextWindow?: Avail;
  compactions?: Avail;
  compactionCost?: Avail;
  model?: Avail;
  title?: Avail;
  toolCalls?: Avail;
  fileReads?: Avail;
  userTurns?: Avail;
  /** 用户压缩阈值：manual 覆盖 → manual；默认 200K → fallback */
  userContextLimit?: Avail;
}
/** 官方 UI 真值（手工录入，来自 .qoder-credits/overrides/<sessionId>.json）。
 *  IDE 端转录不含 usage，本地算不出 Credits，这是唯一的真值通道；绝不覆盖 totals，只并列展示。 */
interface ManualTruth {
  file?: string;
  credits: number | null;
  originalCredits: number | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  note: string | null;
  /** 手工锁定模型窗口（如 qwen3-max=1000000），优先于 runtime-config / 反推 / fallback */
  contextWindow?: number | null;
  /** 手工指定 Qoder 压缩触发阈值（默认 200000），驱动 peakUserAdvice */
  userContextLimit?: number | null;
  /** 本地 credits ÷ 官方真值。有子代理时拿 combined 比（官方 UI 扣费 = 主链 + 子代理），
   *  否则覆盖率会被系统性低估（实测 ca2f7834：主链比 0.46、combined 比 0.89）。 */
  localCoverage?: number | null;
  /** main=只比主链 / combined=比主链+子代理 */
  localScope?: "main" | "combined";
  /** 参与对账的本地 credits（按 localScope 取 totals.credits 或 subagents.combined.credits） */
  localCredits?: number | null;
}
/** 峰值占比的「该不该压」结论。阈值算在数据层（breakdown.mjs peakAdvice），
 *  这里只管展示——否则 Canvas 与终端各持一套阈值迟早走偏。tone 直接喂 Callout。 */
interface PeakAdvice {
  level: "low" | "mid" | "sweet" | "high" | "over";
  tone: "info" | "success" | "warning" | "danger";
  text: string;
}
/** 一次压缩 = 一笔普通模型调用（整份上下文当 prompt、摘要当 completion），是会话里单笔最贵的开销。
 *  pre/post 是客户端自估口径；proxy 是能在代理日志里唯一对上时回填的供应商实测值，对不上就 null。 */
interface CompactionEvent {
  index: number;
  at: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  messagesSummarized: number | null;
  /** 压缩后首轮的往返序号与实测输入 = 压缩把上下文压到的地板 */
  nextRequestIndex: number | null;
  nextInputTokens: number | null;
  savedTokens: number | null;
  /** 数据层归一后的生效值：有代理实测就用实测，否则是客户端自估。
   *  渲染端直接取这两个，别自己按 proxy 分支——否则会与合计的口径分叉。 */
  effectiveInputTokens?: number | null;
  effectiveOutputTokens?: number | null;
  proxy?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    ms: number | null;
    matchedBy: string;
  } | null;
}
interface CompactionCost {
  count: number;
  items: CompactionEvent[];
  /** measured = items 里有几笔拿到了供应商实测（其余为客户端自估） */
  totals: { preTokens: number; postTokens: number; savedTokens: number; measured?: number };
}
/** 链路健康度：代理覆盖率 + 最近记录时间 + 最近若干笔的三方归因计数。
 *  逐笔明细属于排障（CLI --request-log），报告只给一行结论。 */
interface LinkHealth {
  matched: number;
  requests: number;
  coverage: number;
  /** proxy / transcript-tokens / transcript-ratio / mixed / transcript（v3 旧报告）/ null */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
  breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
  logRecords?: number;
  lastRecordAt?: string | null;
  /** 参与归因的最近笔数；0 = 运行中的代理是旧版或还没记到诊断 */
  recentRequests?: number;
  proxyErrors?: number | null;
  upstreamRejected?: number | null;
  aborted?: number | null;
  truncated?: number | null;
  noUsage?: number | null;
  slowestMs?: number | null;
  /** 被更新流量推翻的那条陈旧拉起失败记录；null = 没有 */
  supersededFailure?: { error: string; port?: number; at?: string | null } | null;
}
interface Report {
  schemaVersion: number;
  generatedAt: string;
  pluginVersion?: string;
  /** 转录来自哪一代客户端：桌面端富转录有 usage 真值，IDE 端精简转录没有。v2 旧报告无此字段。 */
  source?: "desktop-rich" | "ide-lite" | "unknown";
  /** usage 数字的来源：proxy=代理实测 / transcript-tokens=转录 input_tokens 真值 /
   *  transcript-ratio=转录 ratio×window 推导 / mixed=多档混合 / transcript=v3 旧报告兼容。无 usage 时 null。 */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 可直接粘贴执行的插件入口命令（generate.mjs 用 proxy.mjs 的 selfCmd() 注入）。
   *  Windows 上是插件自带启动器的绝对路径，不要求用户装 Node；模板是静态文本，拿不到就只能硬编码。 */
  selfCmd?: string | null;
  /** 链路健康度一行结论（逐笔明细留给 CLI --request-log） */
  linkHealth?: LinkHealth | null;
  /** 代理 join 诊断（lib/proxylog.mjs）+ 配置/状态（generate.mjs 注入） */
  proxy?: {
    matched: number;
    requests: number;
    /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
    breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
    logPath?: string;
    logExists?: boolean;
    logRecords?: number;
    /** config.json 里 upstream 合法 = 用户已配置代理 */
    configured?: boolean;
    enabled?: boolean;
    port?: number;
    /** 最近一条代理记录的时间；null = 从无流量 */
    lastRecordAt?: string | null;
    /** 已配置但长期零流量（多半已改回官方模型）——软提示可 --stop-proxy */
    dormant?: boolean;
    /** 最近一次自动拉起失败（如端口被占）；ok 时为 null */
    status?: { error: string; port?: number; at?: string | null } | null;
    /** status 那条失败记录是否已被更新的流量推翻（代理在它之后还记到了流量）。
     *  status.json 只写不清，陈旧失败会把用户推去改本来正确的 Base URL，故必须判掉。 */
    statusSuperseded?: boolean;
  };
  availability?: Availability;
  manual?: ManualTruth | null;
  session: {
    id: string | null;
    title: string | null;
    /** custom-title / first-user / session-id —— 令产物文件名可解释 */
    titleSource?: string;
    model: string | null;
    /** runtime-config / manual / unavailable */
    modelSource?: string;
    cwd: string | null;
    turns: number;
    roundTrips: number;
    compactions: number;
    startedAt: string | null;
    endedAt: string | null;
  };
  context: {
    contextWindow: number;
    /** runtime-config=实测 / derived-from-usage=从 usage 反推 / manual=ManualTruth 手工锁定 /
     *  fallback=读不到静默回退 200000 / caller=调用方传入（旧枚举，兼容）。
     *  报告里每个 token 数字都要乘它，回退时必须标出来。 */
    contextWindowSource?: string;
    systemPromptTokens: number;
    netContextTokens: number;
    /** 峰值 = 当前窗口口径：自最近一次压缩起算，压缩边界处归零重新累积 */
    peakContextTokens: number;
    peakContextRatio: number;
    /** 本场历史峰值（跨压缩）；整场没压缩过时与上面相等 */
    peakSessionTokens?: number;
    peakSessionRatio?: number;
    /** 历史峰值是否值得单独交代（与当前窗口峰值相差 ≥1 个百分点），渲染端直接取用不再自判 */
    peakSessionNotable?: boolean;
    /** 峰值占比的「该不该压」结论（对模型窗口）；无有效占比时 null */
    peakAdvice?: PeakAdvice | null;
    /** 用户压缩阈值（Qoder 自动触发点），与模型窗口独立。默认 200000，ManualTruth 可覆盖 */
    userContextLimit?: number;
    /** default=内置 200K / manual=overrides 手写 / config=插件配置 / derived=实测反推 */
    userContextLimitSource?: "default" | "manual" | "config" | "derived";
    /** peakContextTokens ÷ userContextLimit */
    peakUserRatio?: number;
    /** 对用户阈值的「快自动压缩了吗」结论；与 peakAdvice 可矛盾（模型窗口未满但用户阈值已超） */
    peakUserAdvice?: PeakAdvice | null;
    /** v3.2 当前占用头条口径：段内单调递增 ⇒ 峰值≡当前，故以 netContextTokens 作头条，peak 退灰字 */
    currentContextTokens?: number;
    netUserRatio?: number;
    netUserAdvice?: PeakAdvice | null;
    netWindowRatio?: number;
    /** v3.2 自动压缩自校准：本场 trigger=auto 的实际触发点（无需外部配置）与「阈值是否被强制」判定 */
    observedAutoCompactions?: number;
    observedAutoTriggerTokens?: number | null;
    autoTriggerRatio?: number | null;
    thresholdNotEnforced?: boolean;
  };
  totals: {
    billedInputTokens: number;
    netContextTokens: number;
    peakContextTokens: number;
    amplification: number;
    attributedTokens: number;
    coverage: number;
    credits: number;
    originalCredits: number;
    /** 输出 token 总量：仅代理路径有真值，否则 0 且 availability.outputTokens=unavailable */
    outputTokens?: number;
    /** 供应商上下文缓存命中的那部分 prompt：仅代理路径有真值 */
    cachedTokens?: number;
    cachedTrips?: number;
    /** 缓存命中 ÷ 计费输入总量（全局实测约 91.5%：重复叠加的前缀正是缓存的命中对象） */
    cachedShare?: number;
    /** 两个不依赖 usage 的计数，IDE 端占比全缺时仍有可展示的真值 */
    toolCalls?: number;
    fileReads?: number;
  };
  /** credits 的分子到底覆盖了多少：与计费输入总量并排展示时，部分覆盖不说就等于把局部真值当全量。 */
  creditsCoverage?: {
    /** 真正累加进 totals.credits 的往返数 */
    trips: number;
    roundTrips: number;
    /** 这些往返的计费输入之和 */
    tokens: number;
    tokenShare: number;
    /** trips === roundTrips：全覆盖时不必再啰嗦覆盖范围 */
    full: boolean;
  };
  /** 压缩单笔成本（此前只显示「压缩 N 次」，而它是会话里单笔最贵的调用） */
  compactionCost?: CompactionCost;
  byCategory: CatRow[];
  byCategoryDetail: CatDetail[];
  byTool: ToolRow[];
  byFile: FileRow[];
  byRequest: ReqRow[];
  subagents?: Subagents;
  identity: { sumAttributed: number; billedInputTokens: number; absDiff: number; ok: boolean | null };
}

// 注入点：下一行的 REPORT 初值会被 render-canvas.mjs 按整行替换为真实报告 JSON。
const REPORT = {"schemaVersion":3.2,"generatedAt":"2026-10-08T11:24:52.419Z","source":"desktop-rich","usageSource":"transcript-ratio","availability":{"credits":"measured","roundTrips":"measured","contextRatio":"measured","tokens":"derived","outputTokens":"unavailable","cachedTokens":"unavailable","categoryShare":"derived","toolShare":"derived","fileShare":"derived","systemPrompt":"derived","contextWindow":"measured","compactions":"measured","compactionCost":"measured","model":"measured","title":"measured","toolCalls":"measured","fileReads":"measured","userTurns":"measured","userContextLimit":"fallback"},"session":{"id":"cae46cce-0897-47d2-9936-b884ad13654f","title":"https://doc.moyu.info/95","titleSource":"first-user","model":"qfmodel","modelSource":"runtime-config","cwd":"C:\\Users\\bp180\\Desktop\\无限画布","turns":4,"roundTrips":263,"compactions":0,"startedAt":"2026-10-08T08:02:46.246Z","endedAt":"2026-10-08T11:23:33.328Z"},"context":{"contextWindow":1000000,"contextWindowSource":"runtime-config","systemPromptTokens":20226,"netContextTokens":331998,"peakContextTokens":331998,"peakContextRatio":0.331998,"peakSessionTokens":331998,"peakSessionRatio":0.331998,"peakSessionNotable":false,"peakAdvice":{"level":"low","tone":"info","text":"低于盈亏线（39%）。此时压缩在 token 上是亏的：省下的还不够付摘要输出加压缩后重读，别压"},"userContextLimit":200000,"userContextLimitSource":"default","peakUserRatio":1.65999,"peakUserAdvice":{"level":"over","tone":"danger","text":"已经超过上下文窗口本身，随时可能被截断或由客户端在最糟的时机自动压缩，立刻手动压一次"},"currentContextTokens":331998,"netUserRatio":1.65999,"netUserAdvice":{"level":"over","tone":"danger","text":"已经超过上下文窗口本身，随时可能被截断或由客户端在最糟的时机自动压缩，立刻手动压一次"},"netWindowRatio":0.331998,"observedAutoCompactions":0,"observedAutoTriggerTokens":null,"autoTriggerRatio":null,"thresholdNotEnforced":true},"totals":{"billedInputTokens":57796282,"netContextTokens":331998,"peakContextTokens":331998,"amplification":174.09,"attributedTokens":57796282,"coverage":1,"credits":179.469,"originalCredits":179.469,"outputTokens":0,"cachedTokens":0,"cachedTrips":0,"cachedShare":0,"toolCalls":284,"fileReads":116},"creditsCoverage":{"trips":263,"roundTrips":263,"tokens":57796282,"tokenShare":1,"full":true},"compactionCost":{"count":0,"items":[],"totals":{"preTokens":0,"postTokens":0,"savedTokens":0,"measured":0}},"proxy":{"matched":0,"requests":263,"breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":263},"logPath":"C:\\Users\\bp180\\.qoder-credits-proxy\\usage.jsonl","logExists":false,"logRecords":0,"configured":false,"enabled":true,"port":49787,"lastRecordAt":null,"dormant":false,"status":null,"statusSuperseded":false},"byCategory":[{"key":"tool_result","label":"工具返回","tokens":25651110,"share":0.443819379593643},{"key":"system","label":"系统提示词","tokens":5319438,"share":0.09203771965816071},{"key":"assistant_thinking","label":"模型思考","tokens":13780276,"share":0.2384284080200353},{"key":"assistant_tool_use","label":"工具调用","tokens":8476289,"share":0.14665804006627775},{"key":"assistant_text","label":"模型回复","tokens":151206,"share":0.002616186699584308},{"key":"user_input","label":"用户输入","tokens":93145,"share":0.0016116064713620456},{"key":"attachment","label":"附件/技能","tokens":4324818,"share":0.07482865949093655}],"byCategoryDetail":[{"key":"tool_result","label":"工具返回","tokens":25651110,"share":0.443819379593643,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":9576285,"share":0.16569032452797083,"catShare":0.3733282775521776,"trips":18245},{"tool":"Read","label":"docs/integrations/moyu-mvp-api-research.md","kind":"read","tokens":7977634,"share":0.1380302272018844,"catShare":0.311005407939292,"trips":254},{"tool":"Read","label":"src-tauri/src/backend/speech.rs","kind":"read","tokens":3610157,"share":0.0624634798921495,"catShare":0.1407407669970169,"trips":1633},{"tool":"Read","label":"src-tauri/src/backend/provider_adapter.rs","kind":"read","tokens":1406622,"share":0.02433758256521368,"catShare":0.05483668285845686,"trips":255},{"tool":"Read","label":".tmp/moyu-doc.md","kind":"read","tokens":679830,"share":0.011762523942100625,"catShare":0.026502952513858872,"trips":259},{"tool":"Agent","label":"（无路径）","kind":"other","tokens":584084,"share":0.010105911426045814,"catShare":0.02277032480036968,"trips":257},{"tool":"Read","label":"src-tauri/src/backend/model_schema.rs","kind":"read","tokens":260371,"share":0.004504975266480229,"catShare":0.010150469929016942,"trips":465},{"tool":"Read","label":"src/lib/speech.ts","kind":"read","tokens":251630,"share":0.004353732832723679,"catShare":0.009809695188862454,"trips":271},{"tool":"Grep","label":"src-tauri/src/backend/provider.rs","kind":"search","tokens":181426,"share":0.003139052377871522,"catShare":0.007072815028369446,"trips":630},{"tool":"Edit","label":"src-tauri/src/backend/speech.rs","kind":"write","tokens":181104,"share":0.0031334916332633063,"catShare":0.007060285731849526,"trips":4700},{"tool":"Grep","label":"src-tauri/src/backend/speech.rs","kind":"search","tokens":90612,"share":0.0015677859383783827,"catShare":0.0035324864358420613,"trips":363},{"tool":"Edit","label":"src-tauri/src/backend/model_schema.rs","kind":"write","tokens":73104,"share":0.0012648621541937195,"catShare":0.0028499480021620866,"trips":2264},{"tool":"TaskStop","label":"（无路径）","kind":"other","tokens":69805,"share":0.001207776091050362,"catShare":0.002721323463063264,"trips":260},{"tool":"Read","label":"src-tauri/src/backend/types.rs","kind":"read","tokens":67636,"share":0.0011702421647409786,"catShare":0.0026367531895800534,"trips":205},{"tool":"Grep","label":"src-tauri/src/backend/types.rs","kind":"search","tokens":66276,"share":0.001146722991773742,"catShare":0.0025837605217322217,"trips":204},{"tool":null,"label":"其他 27 项","kind":null,"tokens":574535,"share":0.009940688587803543,"catShare":0.022398049848353058,"trips":8825}]},{"key":"system","label":"系统提示词","tokens":5319438,"share":0.09203771965816071,"children":[]},{"key":"assistant_thinking","label":"模型思考","tokens":13780276,"share":0.2384284080200353,"children":[]},{"key":"assistant_tool_use","label":"工具调用","tokens":8476289,"share":0.14665804006627775,"children":[{"tool":"Edit","label":"src-tauri/src/backend/speech.rs","kind":"write","tokens":3857872,"share":0.06674948187974594,"catShare":0.45513687384326484,"trips":4700},{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":1488506,"share":0.02575435361273621,"catShare":0.17560819441673498,"trips":18245},{"tool":"Edit","label":"src-tauri/src/backend/model_schema.rs","kind":"write","tokens":824249,"share":0.01426128306760528,"catShare":0.09724174045391795,"trips":2264},{"tool":"Write","label":"docs/integrations/moyu-tts-seed-audio.md","kind":"write","tokens":379087,"share":0.006559022211651882,"catShare":0.04472323650778182,"trips":149},{"tool":"Edit","label":"src-tauri/src/backend/commands.rs","kind":"write","tokens":376974,"share":0.006522456865266311,"catShare":0.044473912663217645,"trips":738},{"tool":"AskUserQuestion","label":"（无路径）","kind":"other","tokens":269070,"share":0.004655491839762283,"catShare":0.03174385691816399,"trips":244},{"tool":"Agent","label":"（无路径）","kind":"other","tokens":173043,"share":0.0029940111253320767,"catShare":0.020414912977011163,"trips":257},{"tool":"TaskCreate","label":"（无路径）","kind":"other","tokens":156515,"share":0.002708038052911444,"catShare":0.01846498188362279,"trips":1410},{"tool":"Edit","label":"src/lib/providerAdapters.test.ts","kind":"write","tokens":145778,"share":0.002522280058797507,"catShare":0.0171983756066673,"trips":634},{"tool":"Edit","label":"src/lib/speech.ts","kind":"write","tokens":127847,"share":0.0022120336737712757,"catShare":0.01508293491970582,"trips":541},{"tool":"Edit","label":"src/features/settings/ProviderSettingsDialog.tsx","kind":"write","tokens":126300,"share":0.0021852615465266984,"catShare":0.014900386951435696,"trips":790},{"tool":"Edit","label":"C:/Users/bp180/AppData/Local/Temp/ic-head-check/src-tauri/src/backend/storage/generation_lifecycle.rs","kind":"write","tokens":110772,"share":0.0019165967589358998,"catShare":0.01306847383252736,"trips":460},{"tool":"Edit","label":"src/lib/providerAdapters.ts","kind":"write","tokens":76704,"share":0.0013271489191734919,"catShare":0.00904927488853476,"trips":313},{"tool":"Read","label":"src-tauri/src/backend/speech.rs","kind":"read","tokens":49547,"share":0.0008572709262556021,"catShare":0.0058453728542136795,"trips":1633},{"tool":"Edit","label":"src/features/workspace/comicDramaWorkflowRunner.test.ts","kind":"write","tokens":44713,"share":0.0007736270489434054,"catShare":0.005275040145046174,"trips":190},{"tool":null,"label":"其他 27 项","kind":null,"tokens":269312,"share":0.004659682478862172,"catShare":0.031772431138152174,"trips":6522}]},{"key":"assistant_text","label":"模型回复","tokens":151206,"share":0.002616186699584308,"children":[]},{"key":"user_input","label":"用户输入","tokens":93145,"share":0.0016116064713620456,"children":[]},{"key":"attachment","label":"附件/技能","tokens":4324818,"share":0.07482865949093655,"children":[]}],"byTool":[{"tool":"Read","tokens":14504040,"calls":25,"perCall":580162,"share":0.25095109161609325},{"tool":"Bash","tokens":11064791,"calls":148,"perCall":74762,"share":0.1914446781407064},{"tool":"Edit","tokens":6156364,"calls":78,"perCall":78928,"share":0.10651834359452511},{"tool":"Agent","tokens":757127,"calls":1,"perCall":757127,"share":0.013099922551377886},{"tool":"Grep","tokens":639501,"calls":12,"perCall":53292,"share":0.011064741293375823},{"tool":"Write","tokens":383451,"calls":1,"perCall":383451,"share":0.006634532987411272},{"tool":"AskUserQuestion","tokens":309935,"calls":1,"perCall":309935,"share":0.005362547325032675},{"tool":"TaskCreate","tokens":191849,"calls":6,"perCall":31975,"share":0.003319398158795993},{"tool":"TaskStop","tokens":71379,"calls":2,"perCall":35689,"share":0.0012350089570076052},{"tool":"WebFetch","tokens":28716,"calls":1,"perCall":28716,"share":0.0004968460985474881},{"tool":"TaskUpdate","tokens":17645,"calls":8,"perCall":2206,"share":0.0003052885111292983},{"tool":"Skill","tokens":2602,"calls":1,"perCall":2602,"share":0.000045020425918289515}],"byFile":[{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\docs\\integrations\\moyu-mvp-api-research.md","label":"docs/integrations/moyu-mvp-api-research.md","kind":"read","tool":"Read","selfTokens":31167,"reads":1,"trips":508,"billed":7984551,"perRead":7984551,"share":0.13814990658963167},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\speech.rs","label":"src-tauri/src/backend/speech.rs","kind":"read","tool":"Read","selfTokens":39756,"reads":39,"trips":13392,"billed":7812427,"perRead":200319,"share":0.13517179154179496},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\provider_adapter.rs","label":"src-tauri/src/backend/provider_adapter.rs","kind":"read","tool":"Read","selfTokens":5492,"reads":1,"trips":510,"billed":1413571,"perRead":1413571,"share":0.02445782313781399},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\model_schema.rs","label":"src-tauri/src/backend/model_schema.rs","kind":"read","tool":"Read","selfTokens":5111,"reads":12,"trips":5458,"billed":1172740,"perRead":97728,"share":0.020290923493650827},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\.tmp\\moyu-doc.md","label":".tmp/moyu-doc.md","kind":"read","tool":"Read","selfTokens":2613,"reads":1,"trips":518,"billed":685338,"perRead":685338,"share":0.011857822168483386},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\lib\\speech.ts","label":"src/lib/speech.ts","kind":"read","tool":"Read","selfTokens":2931,"reads":8,"trips":1624,"billed":408676,"perRead":51085,"share":0.007070975156020718},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\commands.rs","label":"src-tauri/src/backend/commands.rs","kind":"write","tool":"Edit","selfTokens":4472,"reads":9,"trips":1476,"billed":401628,"perRead":44625,"share":0.0069490236421831655},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\docs\\integrations\\moyu-tts-seed-audio.md","label":"docs/integrations/moyu-tts-seed-audio.md","kind":"write","tool":"Write","selfTokens":2548,"reads":1,"trips":298,"billed":383451,"perRead":383451,"share":0.006634532987411272},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\provider.rs","label":"src-tauri/src/backend/provider.rs","kind":"search","tool":"Grep","selfTokens":1114,"reads":4,"trips":1684,"billed":236563,"perRead":59141,"share":0.004093049121756459},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\lib\\providerAdapters.test.ts","label":"src/lib/providerAdapters.test.ts","kind":"write","tool":"Edit","selfTokens":1970,"reads":8,"trips":1594,"billed":220259,"perRead":27532,"share":0.003810961010561691},{"attr":"file:C:\\Users\\bp180\\AppData\\Local\\Temp\\ic-head-check\\src-tauri\\src\\backend\\storage\\generation_lifecycle.rs","label":"C:/Users/bp180/AppData/Local/Temp/ic-head-check/src-tauri/src/backend/storage/generation_lifecycle.rs","kind":"read","tool":"Read","selfTokens":2018,"reads":7,"trips":1292,"billed":188333,"perRead":26905,"share":0.0032585578693410237},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\features\\settings\\ProviderSettingsDialog.tsx","label":"src/features/settings/ProviderSettingsDialog.tsx","kind":"write","tool":"Edit","selfTokens":966,"reads":5,"trips":1580,"billed":154219,"perRead":30844,"share":0.0026683218449483656},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\types.rs","label":"src-tauri/src/backend/types.rs","kind":"read","tool":"Read","selfTokens":729,"reads":2,"trips":818,"billed":150408,"perRead":75204,"share":0.002602389399367101},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\features\\workspace\\comicDramaWorkflowRunner.test.ts","label":"src/features/workspace/comicDramaWorkflowRunner.test.ts","kind":"search","tool":"Grep","selfTokens":2808,"reads":6,"trips":744,"billed":124770,"perRead":20795,"share":0.0021587962543471923},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\CONTEXT.md","label":"CONTEXT.md","kind":"search","tool":"Grep","selfTokens":813,"reads":2,"trips":518,"billed":106509,"perRead":53255,"share":0.0018428385418242836},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\lib\\providerAdapters.ts","label":"src/lib/providerAdapters.ts","kind":"write","tool":"Edit","selfTokens":878,"reads":3,"trips":626,"billed":86292,"perRead":28764,"share":0.0014930382303175286},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\features\\workspace\\ComicDramaWorkflowSections.tsx","label":"src/features/workspace/ComicDramaWorkflowSections.tsx","kind":"search","tool":"Grep","selfTokens":350,"reads":1,"trips":254,"billed":44915,"perRead":44915,"share":0.0007771242047462166},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src\\features\\settings","label":"src/features/settings","kind":"search","tool":"Grep","selfTokens":183,"reads":1,"trips":326,"billed":30116,"perRead":30116,"share":0.0005210765459385806},{"attr":"file:C:\\Users\\bp180\\AppData\\Local\\Temp\\qoder-cli-cn\\C--Users-bp180-Desktop-----\\5a9b2172-aba5-473a-879b-fbbeecacf2d7\\tasks\\b4pyd1bhf.output","label":"C:/Users/bp180/AppData/Local/Temp/qoder-cli-cn/C--Users-bp180-Desktop-----/5a9b2172-aba5-473a-879b-fbbeecacf2d7/tasks/b4pyd1bhf.output","kind":"read","tool":"Read","selfTokens":187,"reads":1,"trips":296,"billed":27954,"perRead":27954,"share":0.00048366622660536165},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\.tmp\\verify\\speech.txt","label":".tmp/verify/speech.txt","kind":"read","tool":"Read","selfTokens":261,"reads":1,"trips":126,"billed":16591,"perRead":16591,"share":0.0002870585821585385},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布","label":"C:/Users/bp180/Desktop/无限画布","kind":"search","tool":"Grep","selfTokens":76,"reads":1,"trips":428,"billed":16410,"perRead":16410,"share":0.00028393131108602675},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src","label":"src","kind":"search","tool":"Grep","selfTokens":61,"reads":1,"trips":318,"billed":9794,"perRead":9794,"share":0.00016945097515934387},{"attr":"file:C:\\Users\\bp180\\Desktop\\无限画布\\src-tauri\\src\\backend\\storage\\generation_lifecycle.rs","label":"src-tauri/src/backend/storage/generation_lifecycle.rs","kind":"write","tool":"Edit","selfTokens":324,"reads":1,"trips":48,"billed":7840,"perRead":7840,"share":0.00013565065625762693}],"byAttr":[{"attr":"tool_result|Read","tokens":14388110,"share":0.2489452443369787},{"attr":"assistant_thinking","tokens":13780276,"share":0.2384284080200353},{"attr":"tool_result|Bash","tokens":9576285,"share":0.16569032452797083},{"attr":"tool_use|Edit","tokens":5747710,"share":0.09944774048285648},{"attr":"system","tokens":5319438,"share":0.09203771965816071},{"attr":"attachment","tokens":4324818,"share":0.07482865949093655},{"attr":"tool_use|Bash","tokens":1488506,"share":0.02575435361273621},{"attr":"tool_result|Agent","tokens":584084,"share":0.010105911426045814},{"attr":"tool_result|Grep","tokens":525298,"share":0.009088790658403813},{"attr":"tool_result|Edit","tokens":408655,"share":0.007070603111667511},{"attr":"tool_use|Write","tokens":379087,"share":0.006559022211651882},{"attr":"tool_use|AskUserQuestion","tokens":269070,"share":0.004655491839762283},{"attr":"tool_use|Agent","tokens":173043,"share":0.0029940111253320767},{"attr":"tool_use|TaskCreate","tokens":156515,"share":0.002708038052911444},{"attr":"assistant_text","tokens":151206,"share":0.002616186699584308},{"attr":"tool_use|Read","tokens":115931,"share":0.002005847279115909},{"attr":"tool_use|Grep","tokens":114203,"share":0.001975950634972031},{"attr":"user_input","tokens":93145,"share":0.0016116064713620456},{"attr":"tool_result|TaskStop","tokens":69805,"share":0.001207776091050362},{"attr":"tool_result|AskUserQuestion","tokens":40865,"share":0.0007070554852703925},{"attr":"tool_result|TaskCreate","tokens":35334,"share":0.0006113601058845536},{"attr":"tool_use|WebFetch","tokens":17814,"share":0.00030822859817297905},{"attr":"tool_result|WebFetch","tokens":10901,"share":0.00018861750037450954},{"attr":"tool_use|TaskUpdate","tokens":10587,"share":0.00018317310667757936},{"attr":"tool_result|TaskUpdate","tokens":7058,"share":0.00012211540445171938},{"attr":"tool_result|Write","tokens":4364,"share":0.00007551077575939048},{"attr":"tool_use|Skill","tokens":2251,"share":0.000038950256131553844},{"attr":"tool_use|TaskStop","tokens":1574,"share":0.00002723286595724364},{"attr":"tool_result|Skill","tokens":351,"share":0.000006070169786735663}],"byRequest":[{"index":1,"time":"16:02","ratio":0.02579,"inputTokens":25790,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.733,"originalCredits":0.733,"afterCompact":false},{"index":2,"time":"16:03","ratio":0.028155,"inputTokens":28155,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":3,"time":"16:03","ratio":0.028434,"inputTokens":28434,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.081,"originalCredits":0.081,"afterCompact":false},{"index":4,"time":"16:03","ratio":0.02862,"inputTokens":28620,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.073,"originalCredits":0.073,"afterCompact":false},{"index":5,"time":"16:03","ratio":0.031886,"inputTokens":31886,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.194,"originalCredits":0.194,"afterCompact":false},{"index":6,"time":"16:03","ratio":0.035808,"inputTokens":35808,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.235,"originalCredits":0.235,"afterCompact":false},{"index":7,"time":"16:08","ratio":0.039968,"inputTokens":39968,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.265,"originalCredits":0.265,"afterCompact":false},{"index":8,"time":"16:08","ratio":0.051601,"inputTokens":51601,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.449,"originalCredits":0.449,"afterCompact":false},{"index":9,"time":"16:08","ratio":0.060017,"inputTokens":60017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":10,"time":"16:08","ratio":0.088219,"inputTokens":88219,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.978,"originalCredits":0.978,"afterCompact":false},{"index":11,"time":"16:09","ratio":0.093107,"inputTokens":93107,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":12,"time":"16:09","ratio":0.094897,"inputTokens":94897,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":13,"time":"16:09","ratio":0.096984,"inputTokens":96984,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.303,"originalCredits":0.303,"afterCompact":false},{"index":14,"time":"16:09","ratio":0.099901,"inputTokens":99901,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":15,"time":"16:10","ratio":0.100747,"inputTokens":100747,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":16,"time":"16:10","ratio":0.101076,"inputTokens":101076,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.251,"originalCredits":0.251,"afterCompact":false},{"index":17,"time":"16:10","ratio":0.101882,"inputTokens":101882,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.257,"originalCredits":0.257,"afterCompact":false},{"index":18,"time":"16:10","ratio":0.103007,"inputTokens":103007,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.301,"originalCredits":0.301,"afterCompact":false},{"index":19,"time":"16:11","ratio":0.104348,"inputTokens":104348,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":20,"time":"16:14","ratio":0.106841,"inputTokens":106841,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.562,"originalCredits":0.562,"afterCompact":false},{"index":21,"time":"16:14","ratio":0.112302,"inputTokens":112302,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.406,"originalCredits":0.406,"afterCompact":false},{"index":22,"time":"16:15","ratio":0.11306,"inputTokens":113060,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.32,"originalCredits":0.32,"afterCompact":false},{"index":23,"time":"16:15","ratio":0.114878,"inputTokens":114878,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.32,"originalCredits":0.32,"afterCompact":false},{"index":24,"time":"16:16","ratio":0.116531,"inputTokens":116531,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.449,"originalCredits":0.449,"afterCompact":false},{"index":25,"time":"16:16","ratio":0.119912,"inputTokens":119912,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":26,"time":"16:16","ratio":0.121183,"inputTokens":121183,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.456,"originalCredits":0.456,"afterCompact":false},{"index":27,"time":"16:17","ratio":0.124878,"inputTokens":124878,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.409,"originalCredits":0.409,"afterCompact":false},{"index":28,"time":"16:17","ratio":0.127017,"inputTokens":127017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":29,"time":"16:17","ratio":0.128017,"inputTokens":128017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.324,"originalCredits":0.324,"afterCompact":false},{"index":30,"time":"16:17","ratio":0.129058,"inputTokens":129058,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.397,"originalCredits":0.397,"afterCompact":false},{"index":31,"time":"16:18","ratio":0.130503,"inputTokens":130503,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":32,"time":"16:18","ratio":0.130771,"inputTokens":130771,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.308,"originalCredits":0.308,"afterCompact":false},{"index":33,"time":"16:18","ratio":0.131327,"inputTokens":131327,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.345,"originalCredits":0.345,"afterCompact":false},{"index":34,"time":"16:18","ratio":0.132031,"inputTokens":132031,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":35,"time":"16:18","ratio":0.132317,"inputTokens":132317,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":36,"time":"16:19","ratio":0.132884,"inputTokens":132884,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":37,"time":"16:19","ratio":0.133706,"inputTokens":133706,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.366,"originalCredits":0.366,"afterCompact":false},{"index":38,"time":"16:19","ratio":0.134985,"inputTokens":134985,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.37,"originalCredits":0.37,"afterCompact":false},{"index":39,"time":"16:19","ratio":0.135864,"inputTokens":135864,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":40,"time":"16:19","ratio":0.136503,"inputTokens":136503,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.33,"originalCredits":0.33,"afterCompact":false},{"index":41,"time":"16:20","ratio":0.136942,"inputTokens":136942,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.397,"originalCredits":0.397,"afterCompact":false},{"index":42,"time":"16:20","ratio":0.138349,"inputTokens":138349,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.423,"originalCredits":0.423,"afterCompact":false},{"index":43,"time":"16:20","ratio":0.139726,"inputTokens":139726,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":44,"time":"16:21","ratio":0.140022,"inputTokens":140022,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.345,"originalCredits":0.345,"afterCompact":false},{"index":45,"time":"16:21","ratio":0.140494,"inputTokens":140494,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.333,"originalCredits":0.333,"afterCompact":false},{"index":46,"time":"16:21","ratio":0.141703,"inputTokens":141703,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.376,"originalCredits":0.376,"afterCompact":false},{"index":47,"time":"16:21","ratio":0.142258,"inputTokens":142258,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.377,"originalCredits":0.377,"afterCompact":false},{"index":48,"time":"16:21","ratio":0.143085,"inputTokens":143085,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.362,"originalCredits":0.362,"afterCompact":false},{"index":49,"time":"16:23","ratio":0.143578,"inputTokens":143578,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.346,"originalCredits":0.346,"afterCompact":false},{"index":50,"time":"16:24","ratio":0.14403,"inputTokens":144030,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.364,"originalCredits":0.364,"afterCompact":false},{"index":51,"time":"16:24","ratio":0.145107,"inputTokens":145107,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.556,"originalCredits":0.556,"afterCompact":false},{"index":52,"time":"16:25","ratio":0.148593,"inputTokens":148593,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.49,"originalCredits":0.49,"afterCompact":false},{"index":53,"time":"16:25","ratio":0.149843,"inputTokens":149843,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.391,"originalCredits":0.391,"afterCompact":false},{"index":54,"time":"16:25","ratio":0.150567,"inputTokens":150567,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.381,"originalCredits":0.381,"afterCompact":false},{"index":55,"time":"16:25","ratio":0.151093,"inputTokens":151093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.366,"originalCredits":0.366,"afterCompact":false},{"index":56,"time":"16:25","ratio":0.151437,"inputTokens":151437,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.37,"originalCredits":0.37,"afterCompact":false},{"index":57,"time":"16:25","ratio":0.15191,"inputTokens":151910,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":58,"time":"16:26","ratio":0.152378,"inputTokens":152378,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.411,"originalCredits":0.411,"afterCompact":false},{"index":59,"time":"16:26","ratio":0.153844,"inputTokens":153844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.387,"originalCredits":0.387,"afterCompact":false},{"index":60,"time":"16:26","ratio":0.154411,"inputTokens":154411,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.371,"originalCredits":0.371,"afterCompact":false},{"index":61,"time":"16:26","ratio":0.154877,"inputTokens":154877,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.466,"originalCredits":0.466,"afterCompact":false},{"index":62,"time":"16:28","ratio":0.156779,"inputTokens":156779,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.847,"originalCredits":0.847,"afterCompact":false},{"index":63,"time":"16:28","ratio":0.164336,"inputTokens":164336,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.601,"originalCredits":0.601,"afterCompact":false},{"index":64,"time":"16:28","ratio":0.16533,"inputTokens":165330,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.413,"originalCredits":0.413,"afterCompact":false},{"index":65,"time":"16:28","ratio":0.16622,"inputTokens":166220,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.398,"originalCredits":0.398,"afterCompact":false},{"index":66,"time":"16:29","ratio":0.167924,"inputTokens":167924,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.445,"originalCredits":0.445,"afterCompact":false},{"index":67,"time":"16:29","ratio":0.168437,"inputTokens":168437,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.404,"originalCredits":0.404,"afterCompact":false},{"index":68,"time":"16:29","ratio":0.168757,"inputTokens":168757,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":69,"time":"16:29","ratio":0.169846,"inputTokens":169846,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.422,"originalCredits":0.422,"afterCompact":false},{"index":70,"time":"16:29","ratio":0.172186,"inputTokens":172186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.449,"originalCredits":0.449,"afterCompact":false},{"index":71,"time":"16:31","ratio":0.174476,"inputTokens":174476,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.989,"originalCredits":0.989,"afterCompact":false},{"index":72,"time":"16:31","ratio":0.183776,"inputTokens":183776,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.686,"originalCredits":0.686,"afterCompact":false},{"index":73,"time":"16:31","ratio":0.184498,"inputTokens":184498,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.453,"originalCredits":0.453,"afterCompact":false},{"index":74,"time":"16:33","ratio":0.1853,"inputTokens":185300,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.477,"originalCredits":0.477,"afterCompact":false},{"index":75,"time":"16:33","ratio":0.186095,"inputTokens":186095,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.441,"originalCredits":0.441,"afterCompact":false},{"index":76,"time":"16:34","ratio":0.18626,"inputTokens":186260,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.534,"originalCredits":0.534,"afterCompact":false},{"index":77,"time":"16:34","ratio":0.188933,"inputTokens":188933,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.685,"originalCredits":0.685,"afterCompact":false},{"index":78,"time":"16:34","ratio":0.192268,"inputTokens":192268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.56,"originalCredits":0.56,"afterCompact":false},{"index":79,"time":"16:36","ratio":0.193767,"inputTokens":193767,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.481,"originalCredits":0.481,"afterCompact":false},{"index":80,"time":"16:36","ratio":0.194025,"inputTokens":194025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.461,"originalCredits":0.461,"afterCompact":false},{"index":81,"time":"16:36","ratio":0.195078,"inputTokens":195078,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.471,"originalCredits":0.471,"afterCompact":false},{"index":82,"time":"16:37","ratio":0.195415,"inputTokens":195415,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.459,"originalCredits":0.459,"afterCompact":false},{"index":83,"time":"16:37","ratio":0.195739,"inputTokens":195739,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.458,"originalCredits":0.458,"afterCompact":false},{"index":84,"time":"16:37","ratio":0.196094,"inputTokens":196094,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.473,"originalCredits":0.473,"afterCompact":false},{"index":85,"time":"16:38","ratio":0.19661,"inputTokens":196610,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.46,"originalCredits":0.46,"afterCompact":false},{"index":86,"time":"16:38","ratio":0.196827,"inputTokens":196827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.455,"originalCredits":0.455,"afterCompact":false},{"index":87,"time":"16:38","ratio":0.19708,"inputTokens":197080,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.456,"originalCredits":0.456,"afterCompact":false},{"index":88,"time":"16:48","ratio":0.197397,"inputTokens":197397,"outputTokens":null,"usageSource":"transcript-ratio","credits":5.496,"originalCredits":5.496,"afterCompact":false},{"index":89,"time":"16:48","ratio":0.198106,"inputTokens":198106,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.487,"originalCredits":0.487,"afterCompact":false},{"index":90,"time":"16:48","ratio":0.198941,"inputTokens":198941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.471,"originalCredits":0.471,"afterCompact":false},{"index":91,"time":"16:49","ratio":0.199518,"inputTokens":199518,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.499,"originalCredits":0.499,"afterCompact":false},{"index":92,"time":"16:49","ratio":0.200254,"inputTokens":200254,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.483,"originalCredits":0.483,"afterCompact":false},{"index":93,"time":"16:49","ratio":0.200587,"inputTokens":200587,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.467,"originalCredits":0.467,"afterCompact":false},{"index":94,"time":"16:49","ratio":0.201006,"inputTokens":201006,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.474,"originalCredits":0.474,"afterCompact":false},{"index":95,"time":"16:49","ratio":0.201337,"inputTokens":201337,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.463,"originalCredits":0.463,"afterCompact":false},{"index":96,"time":"16:50","ratio":0.202155,"inputTokens":202155,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.516,"originalCredits":0.516,"afterCompact":false},{"index":97,"time":"16:50","ratio":0.203176,"inputTokens":203176,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.496,"originalCredits":0.496,"afterCompact":false},{"index":98,"time":"16:50","ratio":0.203525,"inputTokens":203525,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.486,"originalCredits":0.486,"afterCompact":false},{"index":99,"time":"16:50","ratio":0.203989,"inputTokens":203989,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.476,"originalCredits":0.476,"afterCompact":false},{"index":100,"time":"16:50","ratio":0.204435,"inputTokens":204435,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.479,"originalCredits":0.479,"afterCompact":false},{"index":101,"time":"16:51","ratio":0.204775,"inputTokens":204775,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.474,"originalCredits":0.474,"afterCompact":false},{"index":102,"time":"16:51","ratio":0.204989,"inputTokens":204989,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.48,"originalCredits":0.48,"afterCompact":false},{"index":103,"time":"16:51","ratio":0.20536,"inputTokens":205360,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.48,"originalCredits":0.48,"afterCompact":false},{"index":104,"time":"16:51","ratio":0.206032,"inputTokens":206032,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.499,"originalCredits":0.499,"afterCompact":false},{"index":105,"time":"16:51","ratio":0.206469,"inputTokens":206469,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.484,"originalCredits":0.484,"afterCompact":false},{"index":106,"time":"16:51","ratio":0.206754,"inputTokens":206754,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.477,"originalCredits":0.477,"afterCompact":false},{"index":107,"time":"16:52","ratio":0.207393,"inputTokens":207393,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.496,"originalCredits":0.496,"afterCompact":false},{"index":108,"time":"16:52","ratio":0.207789,"inputTokens":207789,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.487,"originalCredits":0.487,"afterCompact":false},{"index":109,"time":"16:52","ratio":0.208085,"inputTokens":208085,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":110,"time":"16:52","ratio":0.20882,"inputTokens":208820,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.49,"originalCredits":0.49,"afterCompact":false},{"index":111,"time":"16:52","ratio":0.209267,"inputTokens":209267,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.49,"originalCredits":0.49,"afterCompact":false},{"index":112,"time":"16:52","ratio":0.209538,"inputTokens":209538,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.489,"originalCredits":0.489,"afterCompact":false},{"index":113,"time":"16:52","ratio":0.209937,"inputTokens":209937,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.488,"originalCredits":0.488,"afterCompact":false},{"index":114,"time":"16:53","ratio":0.210823,"inputTokens":210823,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.637,"originalCredits":0.637,"afterCompact":false},{"index":115,"time":"16:53","ratio":0.213297,"inputTokens":213297,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.548,"originalCredits":0.548,"afterCompact":false},{"index":116,"time":"16:53","ratio":0.213832,"inputTokens":213832,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.505,"originalCredits":0.505,"afterCompact":false},{"index":117,"time":"16:54","ratio":0.214477,"inputTokens":214477,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.505,"originalCredits":0.505,"afterCompact":false},{"index":118,"time":"16:54","ratio":0.214804,"inputTokens":214804,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.507,"originalCredits":0.507,"afterCompact":false},{"index":119,"time":"16:54","ratio":0.215185,"inputTokens":215185,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":120,"time":"16:54","ratio":0.215578,"inputTokens":215578,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":121,"time":"16:54","ratio":0.215993,"inputTokens":215993,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.498,"originalCredits":0.498,"afterCompact":false},{"index":122,"time":"16:55","ratio":0.216264,"inputTokens":216264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.51,"originalCredits":0.51,"afterCompact":false},{"index":123,"time":"16:55","ratio":0.216845,"inputTokens":216845,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.516,"originalCredits":0.516,"afterCompact":false},{"index":124,"time":"16:55","ratio":0.217226,"inputTokens":217226,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.518,"originalCredits":0.518,"afterCompact":false},{"index":125,"time":"16:55","ratio":0.218063,"inputTokens":218063,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.526,"originalCredits":0.526,"afterCompact":false},{"index":126,"time":"16:56","ratio":0.219446,"inputTokens":219446,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.544,"originalCredits":0.544,"afterCompact":false},{"index":127,"time":"16:57","ratio":0.220345,"inputTokens":220345,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.561,"originalCredits":0.561,"afterCompact":false},{"index":128,"time":"16:57","ratio":0.221638,"inputTokens":221638,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.549,"originalCredits":0.549,"afterCompact":false},{"index":129,"time":"16:57","ratio":0.222281,"inputTokens":222281,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.529,"originalCredits":0.529,"afterCompact":false},{"index":130,"time":"16:57","ratio":0.222614,"inputTokens":222614,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.515,"originalCredits":0.515,"afterCompact":false},{"index":131,"time":"16:57","ratio":0.222857,"inputTokens":222857,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.527,"originalCredits":0.527,"afterCompact":false},{"index":132,"time":"16:58","ratio":0.223423,"inputTokens":223423,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.55,"originalCredits":0.55,"afterCompact":false},{"index":133,"time":"16:58","ratio":0.224522,"inputTokens":224522,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.548,"originalCredits":0.548,"afterCompact":false},{"index":134,"time":"16:58","ratio":0.225195,"inputTokens":225195,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.537,"originalCredits":0.537,"afterCompact":false},{"index":135,"time":"16:58","ratio":0.225563,"inputTokens":225563,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.525,"originalCredits":0.525,"afterCompact":false},{"index":136,"time":"16:59","ratio":0.22634,"inputTokens":226340,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.535,"originalCredits":0.535,"afterCompact":false},{"index":137,"time":"16:59","ratio":0.226991,"inputTokens":226991,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.531,"originalCredits":0.531,"afterCompact":false},{"index":138,"time":"16:59","ratio":0.227535,"inputTokens":227535,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.567,"originalCredits":0.567,"afterCompact":false},{"index":139,"time":"17:00","ratio":0.228431,"inputTokens":228431,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.542,"originalCredits":0.542,"afterCompact":false},{"index":140,"time":"17:01","ratio":0.228936,"inputTokens":228936,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.573,"originalCredits":0.573,"afterCompact":false},{"index":141,"time":"17:01","ratio":0.229962,"inputTokens":229962,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.552,"originalCredits":0.552,"afterCompact":false},{"index":142,"time":"17:01","ratio":0.230671,"inputTokens":230671,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.587,"originalCredits":0.587,"afterCompact":false},{"index":143,"time":"17:03","ratio":0.232673,"inputTokens":232673,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.6,"originalCredits":0.6,"afterCompact":false},{"index":144,"time":"17:03","ratio":0.23325,"inputTokens":233250,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.571,"originalCredits":0.571,"afterCompact":false},{"index":145,"time":"17:03","ratio":0.233936,"inputTokens":233936,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.555,"originalCredits":0.555,"afterCompact":false},{"index":146,"time":"17:03","ratio":0.234509,"inputTokens":234509,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.553,"originalCredits":0.553,"afterCompact":false},{"index":147,"time":"17:03","ratio":0.235137,"inputTokens":235137,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.549,"originalCredits":0.549,"afterCompact":false},{"index":148,"time":"17:03","ratio":0.235346,"inputTokens":235346,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.536,"originalCredits":0.536,"afterCompact":false},{"index":149,"time":"17:04","ratio":0.2355,"inputTokens":235500,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.544,"originalCredits":0.544,"afterCompact":false},{"index":150,"time":"17:04","ratio":0.237308,"inputTokens":237308,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.61,"originalCredits":0.61,"afterCompact":false},{"index":151,"time":"17:04","ratio":0.237965,"inputTokens":237965,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.557,"originalCredits":0.557,"afterCompact":false},{"index":152,"time":"17:04","ratio":0.23821,"inputTokens":238210,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.548,"originalCredits":0.548,"afterCompact":false},{"index":153,"time":"17:04","ratio":0.238443,"inputTokens":238443,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.555,"originalCredits":0.555,"afterCompact":false},{"index":154,"time":"17:04","ratio":0.238778,"inputTokens":238778,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.568,"originalCredits":0.568,"afterCompact":false},{"index":155,"time":"17:05","ratio":0.239905,"inputTokens":239905,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.579,"originalCredits":0.579,"afterCompact":false},{"index":156,"time":"17:05","ratio":0.241096,"inputTokens":241096,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.581,"originalCredits":0.581,"afterCompact":false},{"index":157,"time":"17:05","ratio":0.241889,"inputTokens":241889,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.565,"originalCredits":0.565,"afterCompact":false},{"index":158,"time":"17:05","ratio":0.243103,"inputTokens":243103,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.609,"originalCredits":0.609,"afterCompact":false},{"index":159,"time":"17:05","ratio":0.243839,"inputTokens":243839,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.647,"originalCredits":0.647,"afterCompact":false},{"index":160,"time":"17:06","ratio":0.245522,"inputTokens":245522,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.61,"originalCredits":0.61,"afterCompact":false},{"index":161,"time":"17:07","ratio":0.246204,"inputTokens":246204,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.578,"originalCredits":0.578,"afterCompact":false},{"index":162,"time":"17:08","ratio":0.246532,"inputTokens":246532,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.611,"originalCredits":0.611,"afterCompact":false},{"index":163,"time":"17:08","ratio":0.247761,"inputTokens":247761,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.601,"originalCredits":0.601,"afterCompact":false},{"index":164,"time":"17:09","ratio":0.248134,"inputTokens":248134,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.573,"originalCredits":0.573,"afterCompact":false},{"index":165,"time":"17:09","ratio":0.248488,"inputTokens":248488,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.571,"originalCredits":0.571,"afterCompact":false},{"index":166,"time":"17:09","ratio":0.249501,"inputTokens":249501,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.595,"originalCredits":0.595,"afterCompact":false},{"index":167,"time":"17:10","ratio":0.250252,"inputTokens":250252,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.663,"originalCredits":0.663,"afterCompact":false},{"index":168,"time":"17:10","ratio":0.251778,"inputTokens":251778,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.616,"originalCredits":0.616,"afterCompact":false},{"index":169,"time":"17:11","ratio":0.252489,"inputTokens":252489,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.606,"originalCredits":0.606,"afterCompact":false},{"index":170,"time":"17:11","ratio":0.25299,"inputTokens":252990,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.584,"originalCredits":0.584,"afterCompact":false},{"index":171,"time":"17:12","ratio":0.253323,"inputTokens":253323,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.592,"originalCredits":0.592,"afterCompact":false},{"index":172,"time":"17:12","ratio":0.253742,"inputTokens":253742,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.6,"originalCredits":0.6,"afterCompact":false},{"index":173,"time":"17:13","ratio":0.254273,"inputTokens":254273,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.785,"originalCredits":0.785,"afterCompact":false},{"index":174,"time":"17:13","ratio":0.257957,"inputTokens":257957,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.702,"originalCredits":0.702,"afterCompact":false},{"index":175,"time":"17:14","ratio":0.259395,"inputTokens":259395,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.692,"originalCredits":0.692,"afterCompact":false},{"index":176,"time":"17:14","ratio":0.260941,"inputTokens":260941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.639,"originalCredits":0.639,"afterCompact":false},{"index":177,"time":"17:14","ratio":0.261451,"inputTokens":261451,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.605,"originalCredits":0.605,"afterCompact":false},{"index":178,"time":"17:14","ratio":0.261726,"inputTokens":261726,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.602,"originalCredits":0.602,"afterCompact":false},{"index":179,"time":"17:14","ratio":0.262321,"inputTokens":262321,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.62,"originalCredits":0.62,"afterCompact":false},{"index":180,"time":"17:14","ratio":0.262748,"inputTokens":262748,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.609,"originalCredits":0.609,"afterCompact":false},{"index":181,"time":"17:15","ratio":0.263099,"inputTokens":263099,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.669,"originalCredits":0.669,"afterCompact":false},{"index":182,"time":"17:17","ratio":0.264498,"inputTokens":264498,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.684,"originalCredits":0.684,"afterCompact":false},{"index":183,"time":"17:18","ratio":0.265664,"inputTokens":265664,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.669,"originalCredits":0.669,"afterCompact":false},{"index":184,"time":"17:18","ratio":0.266782,"inputTokens":266782,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.636,"originalCredits":0.636,"afterCompact":false},{"index":185,"time":"17:23","ratio":0.267186,"inputTokens":267186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.627,"originalCredits":0.627,"afterCompact":false},{"index":186,"time":"18:04","ratio":0.274463,"inputTokens":274463,"outputTokens":null,"usageSource":"transcript-ratio","credits":7.643,"originalCredits":7.643,"afterCompact":false},{"index":187,"time":"18:14","ratio":0.274914,"inputTokens":274914,"outputTokens":null,"usageSource":"transcript-ratio","credits":7.65,"originalCredits":7.65,"afterCompact":false},{"index":188,"time":"18:15","ratio":0.275464,"inputTokens":275464,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.637,"originalCredits":0.637,"afterCompact":false},{"index":189,"time":"18:15","ratio":0.275711,"inputTokens":275711,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.646,"originalCredits":0.646,"afterCompact":false},{"index":190,"time":"18:15","ratio":0.276182,"inputTokens":276182,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.643,"originalCredits":0.643,"afterCompact":false},{"index":191,"time":"18:26","ratio":0.276592,"inputTokens":276592,"outputTokens":null,"usageSource":"transcript-ratio","credits":7.718,"originalCredits":7.718,"afterCompact":false},{"index":192,"time":"18:26","ratio":0.277523,"inputTokens":277523,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.653,"originalCredits":0.653,"afterCompact":false},{"index":193,"time":"18:27","ratio":0.277937,"inputTokens":277937,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.65,"originalCredits":0.65,"afterCompact":false},{"index":194,"time":"18:27","ratio":0.278361,"inputTokens":278361,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.649,"originalCredits":0.649,"afterCompact":false},{"index":195,"time":"18:28","ratio":0.278714,"inputTokens":278714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.679,"originalCredits":0.679,"afterCompact":false},{"index":196,"time":"18:38","ratio":0.279902,"inputTokens":279902,"outputTokens":null,"usageSource":"transcript-ratio","credits":7.796,"originalCredits":7.796,"afterCompact":false},{"index":197,"time":"18:39","ratio":0.281036,"inputTokens":281036,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.682,"originalCredits":0.682,"afterCompact":false},{"index":198,"time":"18:39","ratio":0.28182,"inputTokens":281820,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.697,"originalCredits":0.697,"afterCompact":false},{"index":199,"time":"18:40","ratio":0.282708,"inputTokens":282708,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.667,"originalCredits":0.667,"afterCompact":false},{"index":200,"time":"18:40","ratio":0.283105,"inputTokens":283105,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.645,"originalCredits":0.645,"afterCompact":false},{"index":201,"time":"18:41","ratio":0.283469,"inputTokens":283469,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.73,"originalCredits":0.73,"afterCompact":false},{"index":202,"time":"18:43","ratio":0.28507,"inputTokens":285070,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.731,"originalCredits":0.731,"afterCompact":false},{"index":203,"time":"18:44","ratio":0.287287,"inputTokens":287287,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.739,"originalCredits":0.739,"afterCompact":false},{"index":204,"time":"18:44","ratio":0.288287,"inputTokens":288287,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.68,"originalCredits":0.68,"afterCompact":false},{"index":205,"time":"18:45","ratio":0.288558,"inputTokens":288558,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.66,"originalCredits":0.66,"afterCompact":false},{"index":206,"time":"18:46","ratio":0.28881,"inputTokens":288810,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.661,"originalCredits":0.661,"afterCompact":false},{"index":207,"time":"18:46","ratio":0.289068,"inputTokens":289068,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.692,"originalCredits":0.692,"afterCompact":false},{"index":208,"time":"18:47","ratio":0.289917,"inputTokens":289917,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.722,"originalCredits":0.722,"afterCompact":false},{"index":209,"time":"18:48","ratio":0.290897,"inputTokens":290897,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.693,"originalCredits":0.693,"afterCompact":false},{"index":210,"time":"18:49","ratio":0.292166,"inputTokens":292166,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.806,"originalCredits":0.806,"afterCompact":false},{"index":211,"time":"18:49","ratio":0.294506,"inputTokens":294506,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.771,"originalCredits":0.771,"afterCompact":false},{"index":212,"time":"18:49","ratio":0.295646,"inputTokens":295646,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.696,"originalCredits":0.696,"afterCompact":false},{"index":213,"time":"18:50","ratio":0.296103,"inputTokens":296103,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.679,"originalCredits":0.679,"afterCompact":false},{"index":214,"time":"18:51","ratio":0.296364,"inputTokens":296364,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.676,"originalCredits":0.676,"afterCompact":false},{"index":215,"time":"18:51","ratio":0.29685,"inputTokens":296850,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.68,"originalCredits":0.68,"afterCompact":false},{"index":216,"time":"18:51","ratio":0.297115,"inputTokens":297115,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.678,"originalCredits":0.678,"afterCompact":false},{"index":217,"time":"18:52","ratio":0.29734,"inputTokens":297340,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.684,"originalCredits":0.684,"afterCompact":false},{"index":218,"time":"18:52","ratio":0.297709,"inputTokens":297709,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.682,"originalCredits":0.682,"afterCompact":false},{"index":219,"time":"18:52","ratio":0.298018,"inputTokens":298018,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.681,"originalCredits":0.681,"afterCompact":false},{"index":220,"time":"18:53","ratio":0.298289,"inputTokens":298289,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.678,"originalCredits":0.678,"afterCompact":false},{"index":221,"time":"18:54","ratio":0.298684,"inputTokens":298684,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.684,"originalCredits":0.684,"afterCompact":false},{"index":222,"time":"18:54","ratio":0.299007,"inputTokens":299007,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.687,"originalCredits":0.687,"afterCompact":false},{"index":223,"time":"18:55","ratio":0.299297,"inputTokens":299297,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.682,"originalCredits":0.682,"afterCompact":false},{"index":224,"time":"18:55","ratio":0.299471,"inputTokens":299471,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.685,"originalCredits":0.685,"afterCompact":false},{"index":225,"time":"18:56","ratio":0.299815,"inputTokens":299815,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.754,"originalCredits":0.754,"afterCompact":false},{"index":226,"time":"18:56","ratio":0.301184,"inputTokens":301184,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.758,"originalCredits":0.758,"afterCompact":false},{"index":227,"time":"18:56","ratio":0.302128,"inputTokens":302128,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.711,"originalCredits":0.711,"afterCompact":false},{"index":228,"time":"18:57","ratio":0.302436,"inputTokens":302436,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.705,"originalCredits":0.705,"afterCompact":false},{"index":229,"time":"18:58","ratio":0.303301,"inputTokens":303301,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.724,"originalCredits":0.724,"afterCompact":false},{"index":230,"time":"18:58","ratio":0.304049,"inputTokens":304049,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.722,"originalCredits":0.722,"afterCompact":false},{"index":231,"time":"18:59","ratio":0.304739,"inputTokens":304739,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.717,"originalCredits":0.717,"afterCompact":false},{"index":232,"time":"18:59","ratio":0.305174,"inputTokens":305174,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.713,"originalCredits":0.713,"afterCompact":false},{"index":233,"time":"19:00","ratio":0.305598,"inputTokens":305598,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.76,"originalCredits":0.76,"afterCompact":false},{"index":234,"time":"19:04","ratio":0.307314,"inputTokens":307314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.8,"originalCredits":0.8,"afterCompact":false},{"index":235,"time":"19:05","ratio":0.31146,"inputTokens":311460,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.839,"originalCredits":0.839,"afterCompact":false},{"index":236,"time":"19:05","ratio":0.31278,"inputTokens":312780,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.772,"originalCredits":0.772,"afterCompact":false},{"index":237,"time":"19:06","ratio":0.313929,"inputTokens":313929,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.769,"originalCredits":0.769,"afterCompact":false},{"index":238,"time":"19:06","ratio":0.314682,"inputTokens":314682,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.734,"originalCredits":0.734,"afterCompact":false},{"index":239,"time":"19:07","ratio":0.315964,"inputTokens":315964,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.776,"originalCredits":0.776,"afterCompact":false},{"index":240,"time":"19:07","ratio":0.316696,"inputTokens":316696,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.737,"originalCredits":0.737,"afterCompact":false},{"index":241,"time":"19:08","ratio":0.316982,"inputTokens":316982,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.754,"originalCredits":0.754,"afterCompact":false},{"index":242,"time":"19:09","ratio":0.318194,"inputTokens":318194,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.799,"originalCredits":0.799,"afterCompact":false},{"index":243,"time":"19:09","ratio":0.319261,"inputTokens":319261,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.752,"originalCredits":0.752,"afterCompact":false},{"index":244,"time":"19:11","ratio":0.319569,"inputTokens":319569,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.74,"originalCredits":0.74,"afterCompact":false},{"index":245,"time":"19:12","ratio":0.319966,"inputTokens":319966,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.733,"originalCredits":0.733,"afterCompact":false},{"index":246,"time":"19:12","ratio":0.320578,"inputTokens":320578,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.771,"originalCredits":0.771,"afterCompact":false},{"index":247,"time":"19:13","ratio":0.32146,"inputTokens":321460,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.814,"originalCredits":0.814,"afterCompact":false},{"index":248,"time":"19:13","ratio":0.322784,"inputTokens":322784,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.758,"originalCredits":0.758,"afterCompact":false},{"index":249,"time":"19:14","ratio":0.323298,"inputTokens":323298,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.756,"originalCredits":0.756,"afterCompact":false},{"index":250,"time":"19:14","ratio":0.323741,"inputTokens":323741,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.744,"originalCredits":0.744,"afterCompact":false},{"index":251,"time":"19:15","ratio":0.324004,"inputTokens":324004,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.74,"originalCredits":0.74,"afterCompact":false},{"index":252,"time":"19:15","ratio":0.324263,"inputTokens":324263,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.748,"originalCredits":0.748,"afterCompact":false},{"index":253,"time":"19:15","ratio":0.324691,"inputTokens":324691,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.738,"originalCredits":0.738,"afterCompact":false},{"index":254,"time":"19:16","ratio":0.325141,"inputTokens":325141,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.748,"originalCredits":0.748,"afterCompact":false},{"index":255,"time":"19:16","ratio":0.325421,"inputTokens":325421,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.751,"originalCredits":0.751,"afterCompact":false},{"index":256,"time":"19:17","ratio":0.325807,"inputTokens":325807,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.822,"originalCredits":0.822,"afterCompact":false},{"index":257,"time":"19:17","ratio":0.327358,"inputTokens":327358,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.806,"originalCredits":0.806,"afterCompact":false},{"index":258,"time":"19:19","ratio":0.32811,"inputTokens":328110,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.769,"originalCredits":0.769,"afterCompact":false},{"index":259,"time":"19:20","ratio":0.328658,"inputTokens":328658,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.82,"originalCredits":0.82,"afterCompact":false},{"index":260,"time":"19:20","ratio":0.329972,"inputTokens":329972,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.788,"originalCredits":0.788,"afterCompact":false},{"index":261,"time":"19:21","ratio":0.330416,"inputTokens":330416,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.768,"originalCredits":0.768,"afterCompact":false},{"index":262,"time":"19:21","ratio":0.331268,"inputTokens":331268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.785,"originalCredits":0.785,"afterCompact":false},{"index":263,"time":"19:23","ratio":0.331998,"inputTokens":331998,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.818,"originalCredits":0.818,"afterCompact":false}],"identity":{"sumAttributed":57796282,"billedInputTokens":57796282,"absDiff":0,"ok":true},"pluginVersion":"2.7.4","selfCmd":"\"C:\\Users\\bp180\\.qoder-cn\\plugins\\cache\\qoder-marketplace\\qoder-credits-inspector\\2.7.4\\bin\\credits-inspector.cmd\" cli","linkHealth":{"matched":0,"requests":263,"coverage":0,"usageSource":"transcript-ratio","breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":263},"logRecords":0,"lastRecordAt":null,"recentRequests":0,"proxyErrors":null,"clientAbort":null,"clientAbortMaxMs":null,"upstreamRejected":null,"aborted":null,"truncated":null,"noUsage":null,"slowestMs":null,"supersededFailure":null},"subagents":{"scanned":true,"dir":"C:\\Users\\bp180\\.qoder-cn\\projects\\C--Users-bp180-Desktop-----\\5a9b2172-aba5-473a-879b-fbbeecacf2d7\\subagents","probedPaths":["C:\\Users\\bp180\\.qoder-cn\\projects\\C--Users-bp180-Desktop-----\\5a9b2172-aba5-473a-879b-fbbeecacf2d7\\subagents","C:\\Users\\bp180\\.qoder-cn\\projects\\5a9b2172-aba5-473a-879b-fbbeecacf2d7\\subagents"],"reason":"ok","count":1,"items":[{"agentId":"aExplore-d95ad32a937524fe","agentType":"Explore","description":"Map provider/connection architecture","toolUseId":"call_7ef71d2d248049028d62c125","roundTrips":27,"billedInputTokens":309177,"peakContextRatio":0.0911,"credits":6.446,"originalCredits":6.446,"error":null}],"totals":{"roundTrips":27,"billedInputTokens":309177,"credits":6.446,"originalCredits":6.446},"combined":{"roundTrips":290,"billedInputTokens":58105459,"credits":185.915,"originalCredits":185.915}},"manual":null,"artifacts":{"report":"report.json","canvas":"https___doc.moyu.info_95__cae46cce.canvas.tsx"}} as unknown as Report;

function human(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// —— 可用性口径：把 report.availability 翻成人话，并决定某个数字该显示值、「≈」还是「—」——
const AVAIL_LABEL: Record<string, string> = {
  measured: "实测",
  derived: "推导",
  fallback: "回退",
  manual: "手工",
  unavailable: "不可用",
};

const SOURCE_LABEL: Record<string, string> = {
  "desktop-rich": "桌面端富转录",
  "ide-lite": "IDE 端精简转录",
  unknown: "来源未知",
};

function availOf(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): Avail {
  return (av?.[key] as Avail | undefined) ?? dflt;
}

/** 段标题旁的性质标注：实测不标（默认就是实测），其余标出来。 */
function availTag(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): string {
  const v = availOf(av, key, dflt);
  return v === "measured" ? "" : `（${AVAIL_LABEL[v]}）`;
}

/** 不可用的量显示「—」而不是 0：IDE 端的 0 是「读不到」，不是「没发生」。 */
function orDash(
  v: number,
  av: Availability | undefined,
  key: keyof Availability,
  fmt: (n: number) => string = String
): string {
  return availOf(av, key) === "unavailable" ? "—" : fmt(v);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "search":
      return "搜索";
    case "shell":
      return "命令";
    default:
      return "其他";
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SessionTokensReport() {
  if (!REPORT) {
    return (
      <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
        <Stack gap="component">
          <H1>会话 token 消耗截析</H1>
          <Text tone="secondary">报告数据尚未注入。请在会话中触发一次 Stop 钩子，或运行 CLI 生成 report.json。</Text>
        </Stack>
      </ReportShell>
    );
  }

  const r = REPORT;
  const s = r.session;
  const c = r.context;
  const t = r.totals;
  const av = r.availability;
  const manual = r.manual ?? null;
  const sourceLabel = SOURCE_LABEL[r.source ?? "unknown"] ?? "来源未知";
  // 有没有 usage 决定整份报告是「真值/推导」还是「一律 —」。手工回填的 credits 不算有 usage，
  // 否则下面按 ratio 推导的图表会照画一堆 0。
  const hasUsage = availOf(av, "roundTrips") === "measured";
  const manualCredits = manual?.credits ?? null;

  // 报告里出现的命令一律用数据层注入的插件入口（Windows 上是自带启动器的绝对路径，免装 Node）。
  // 旧报告没有这个字段时回退原写法，不比改动前更差。
  const CLI = r.selfCmd || "node scripts/cli.mjs";

  // credits 覆盖范围：credits 与「计费输入总量」并排放在头部，读者一除就得到单价。
  // 混合会话里 credits 只来自转录路径的那几笔（实测某会话 413 笔里只有 1 笔带 credits），
  // 部分覆盖不说出来 = 把局部真值当全量展示。
  const cov = r.creditsCoverage ?? null;
  const covPartial = !!(cov && !cov.full && cov.roundTrips > 0);
  const covNote = covPartial ? ` · 仅覆盖 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}）` : "";

  // 缓存命中：代理记录里一直带着 cachedTokens，此前采集了却从不呈现。
  const cachedMeasured = availOf(av, "cachedTokens") === "measured";
  const cachedText = cachedMeasured
    ? `输入 ${human(t.billedInputTokens)}，其中缓存命中 ${human(t.cachedTokens ?? 0)}（${pct(t.cachedShare ?? 0)}，${t.cachedTrips ?? 0} 笔往返带缓存）——供应商对重复叠加的前缀打折，故按 token 数的节省大于按计费的节省。`
    : "";

  // 代理告警只在「失败记录仍然成立」时才报：status.json 只写不清，陈旧失败会把用户推去改
  // 本来正确的 Base URL，越修越坏；而同一份报告里的 lastRecordAt / matched 是它在跑的硬证据。
  const proxyAlarm = r.proxy?.status && !r.proxy.statusSuperseded ? r.proxy.status : null;
  const proxyAlive = !proxyAlarm && (r.proxy?.logRecords ?? 0) > 0;

  // 官方 UI 一场会话扣费 = 主链 + 子代理，故有子代理时 headline 必须给 combined，否则比 UI 少一截
  const creditScope =
    r.subagents && r.subagents.count > 0
      ? {
          credits: r.subagents.combined.credits,
          note: `主链 ${t.credits} + 子代理 ${r.subagents.totals.credits} · 原始 ${r.subagents.combined.originalCredits}`,
        }
      : { credits: t.credits, note: `原始 ${t.originalCredits}（实测）` };

  const headline: MetricItem[] = [
    {
      label: "计费输入总量",
      value: hasUsage ? human(t.billedInputTokens) : "—",
      description: hasUsage
        ? availOf(av, "tokens") === "measured"
          ? `Σ prompt_tokens（实测真值）${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
          : `Σ 上下文 × 往返${availTag(av, "tokens", "derived")}${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
        : "转录无 usage",
    },
    {
      label: "当前上下文",
      value: hasUsage ? human(t.netContextTokens) : "—",
      description: hasUsage
        ? `峰值 ${pct(c.peakContextRatio)}${s.compactions ? "（压缩后起算）" : ""}`
        : "转录无 usage",
    },
    {
      label: "重发放大",
      value: hasUsage ? `${t.amplification}×` : "—",
      description: `往返 ${hasUsage ? `${s.roundTrips} 次` : "—"}`,
    },
    {
      label: "Credits",
      // 代理路径（自定义模型）token 是实测真值但 credits 无来源：hasUsage 为真也要显示「—」，
      // 否则 t.credits=0 会被读成「这次没花钱」。
      value:
        manualCredits != null
          ? `${manualCredits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.credits}`
            : "—",
      description:
        manualCredits != null
          ? `官方 UI 手工录入 · 本地 ${creditScope.credits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.note}${covNote}`
            : r.usageSource === "proxy" || r.usageSource === "transcript-tokens" || r.usageSource === "mixed"
              ? "自定义模型（BYOK）不经 Qoder 计费网关，无 credits 真值"
              : hasUsage
                ? "转录带 usage 但没有 credits 字段，本地无计费真值"
                : "本地不可用，见下方告警",
    },
  ];

  const pieData = r.byCategory.map((x) => ({ label: x.label, value: x.tokens }));

  // 系统提示词是报告里少数「用户能直接动」的一项：它每轮被完整重发，总量 = 每请求规模 × 往返数，
  // 而它的大小由装了多少插件与技能决定。占比小时不必啰嗦。
  const sysCat = r.byCategory.find((x) => x.key === "system");
  const sysNote =
    hasUsage && sysCat && sysCat.share >= 0.1
      ? ` 系统提示词占 ${pct(sysCat.share)}（${human(c.systemPromptTokens)}/请求 × ${s.roundTrips} 次往返 = ${human(sysCat.tokens)}）：它每轮都被完整重发，大小由你装了多少插件与技能决定，精简技能能直接压低这一项——本插件自己的技能描述也常驻在里面（约 170 token）。`
      : "";

  const tools = r.byTool.slice(0, 8);
  const toolCategories = tools.map((x) => x.tool);
  const toolSeries = [{ name: "重发 tokens", data: tools.map((x) => x.tokens) }];
  // 「单次」= 平均每次调用带来的重发 token。总量榜会埋掉次数少但每次极贵的工具：
  // 实测 Read 只 29 次却吃 335 万，单次是 Edit 的 2.6 倍。
  const toolRows = tools.map((x) => [
    x.tool,
    human(x.tokens),
    pct(x.share),
    String(x.calls),
    x.perCall == null ? "—" : human(x.perCall),
  ]);

  const files = r.byFile.slice(0, 20);
  const fileRows = files.map((f) => [
    f.label,
    kindLabel(f.kind),
    human(f.billed),
    pct(f.share),
    f.perRead == null ? "—" : human(f.perRead),
    String(f.trips),
    String(f.reads),
  ]);

  const byReq = r.byRequest ?? [];
  const reqLabels = byReq.map((x, i) => x.time || `#${x.index ?? i + 1}`);
  const reqInputs = byReq.map((x) => x.inputTokens);
  const reqCredits = byReq.map((x) => x.credits);
  // credits 只在覆盖全部往返时才画曲线：部分覆盖（BYOK 混合会话实测 413 笔里 1 笔有 credits）
  // 画出来是一地零，既读不出形状，还会暗示「其余往返没花钱」。
  const showCreditsChart = hasUsage && !covPartial && availOf(av, "credits") !== "unavailable";

  // 按类别下钻：类别小计行（accent/neutral）+ 其工具/文件明细行（default），用 rowTone 分组着色。
  const catDetail = r.byCategoryDetail ?? [];
  const detailRows: string[][] = [];
  const detailTones: ("accent" | "neutral" | "default")[] = [];
  for (const cc of catDetail) {
    const hasKids = cc.children.length > 0;
    detailRows.push([cc.label, "—", hasKids ? "小计" : "（整体，无工具/文件归属）", human(cc.tokens), pct(cc.share), "100%", "—"]);
    detailTones.push(hasKids ? "accent" : "neutral");
    for (const k of cc.children) {
      detailRows.push(["", k.tool || "—", k.label, human(k.tokens), pct(k.share), pct(k.catShare), String(k.trips)]);
      detailTones.push("default");
    }
  }

  // 子代理账：Agent 派发的子代理消耗不在主链里，单独一段呈现（无子代理则整段不渲染）。
  const sub = r.subagents;
  const subItems = sub?.items ?? [];
  const subRows: string[][] = [];
  const subTones: ("accent" | "default")[] = [];
  for (const a of subItems) {
    subRows.push([
      a.description || a.agentId,
      a.agentType || "—",
      String(a.roundTrips),
      human(a.billedInputTokens),
      pct(a.peakContextRatio),
      String(a.credits),
      String(a.originalCredits),
      a.error || "—",
    ]);
    subTones.push("default");
  }
  if (sub && subItems.length > 0) {
    subRows.push([
      "合计（主链 + 子代理）",
      "—",
      String(sub.combined.roundTrips),
      human(sub.combined.billedInputTokens),
      "—",
      String(sub.combined.credits),
      String(sub.combined.originalCredits),
      `主链 ${t.credits} / 子代理 ${sub.totals.credits}`,
    ]);
    subTones.push("accent");
  }

  // 压缩单笔成本：输入/摘要一律取数据层归一后的生效值（有代理实测就是实测，否则是客户端自估），
  // 并用「口径」列把两者分开——混着显示会让自估值被当成实测。
  const ccost = r.compactionCost;
  const ccItems = ccost?.items ?? [];
  const compactRows: string[][] = ccItems.map((e) => [
    `#${e.index}`,
    shortTime(e.at),
    e.trigger || "—",
    e.effectiveInputTokens == null ? "—" : human(e.effectiveInputTokens),
    e.effectiveOutputTokens == null ? "—" : human(e.effectiveOutputTokens),
    e.nextInputTokens == null ? "—" : human(e.nextInputTokens),
    e.savedTokens == null ? "—" : human(e.savedTokens),
    e.proxy && e.proxy.ms != null ? `${Math.round(e.proxy.ms / 1000)}s` : "—",
    e.proxy ? "实测" : "自估",
  ]);

  // IDE 端仅剩的真值：工具调用次数与文件读取次数（不依赖 usage，两种转录都写 tool_use 块）。
  const residueRows: string[][] = [];
  if (!hasUsage) {
    for (const x of r.byTool.filter((v) => v.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 15)) {
      residueRows.push([x.tool, "工具", String(x.calls), "—", "—"]);
    }
    for (const f of r.byFile.filter((v) => v.reads > 0).sort((a, b) => b.reads - a.reads).slice(0, 15)) {
      residueRows.push([f.label, kindLabel(f.kind), "—", String(f.reads), String(f.trips)]);
    }
  }

  // A1 三值：一次带 usage 的往返都没有时 0 <= max(2,0) 恒成立，会把「没数据」判成「校验通过」，
  // 故 breakdown.mjs 在 reqCount===0 时给 null；这里必须显示「不适用」而不是绿色通过。
  const identityText =
    r.identity.ok == null
      ? "恒等式 A1 不适用（本转录没有一次带 usage 的往返）。"
      : r.identity.ok
        ? `归因覆盖 ${pct(t.coverage)}${availTag(av, "categoryShare", "derived")}，恒等式 A1 通过（|Δ|=${r.identity.absDiff}）。`
        : `归因覆盖 ${pct(t.coverage)}，恒等式 A1 未通过（|Δ|=${r.identity.absDiff}）。`;
  // 窗口读不到时是静默回退的 200000，而所有 token 数字都乘它 —— 必须显式标 ≈ 与来源。
  const cwIsFallback = availOf(av, "contextWindow") === "fallback";
  const cwText = cwIsFallback ? `≈${human(c.contextWindow)}（回退值）` : human(c.contextWindow);
  // 当前占用头条：以最新上下文（currentContextTokens）为准；段内单调递增 ⇒ 旧版峰值与当前恒等，故合并为一条。
  const curCtx = c.currentContextTokens ?? c.peakContextTokens;
  const netAdv = c.netUserAdvice || c.peakUserAdvice || c.peakAdvice || null;
  const limitSrcLabel =
    c.userContextLimitSource === "manual" ? "手工"
    : c.userContextLimitSource === "config" ? "配置"
    : c.userContextLimitSource === "derived" ? "实测反推"
    : "默认";
  // 阈值来源非 manual/config/derived ⇒ 用的是内置兜底 200K，不是用户在 Qoder 设的真值，需显式提示如何改。
  const limitIsDefault = c.userContextLimitSource !== "manual" && c.userContextLimitSource !== "config" && c.userContextLimitSource !== "derived";
  // 上下文对比表：把旧版挤成一段小字的「界面显示 / 自动压缩实况 / 历史高点」拆成可扫读的行，无数据不占位。
  const ctxRows: string[][] = [];
  if (c.userContextLimit != null && Number.isFinite(c.contextWindow)) {
    ctxRows.push(
      c.contextWindow > c.userContextLimit
        ? ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型物理窗口 ${cwText} 算，比你真实占比低约 ${(c.contextWindow / c.userContextLimit).toFixed(1)} 倍——界面显得偏空、有迷惑性，别信它`]
        : ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型窗口 ${cwText} 算，与你实设上限一致，显示无偏差`],
    );
  }
  if (c.observedAutoCompactions != null && c.observedAutoCompactions > 0 && c.observedAutoTriggerTokens != null) {
    ctxRows.push(["自动压缩实况", `自动 ${c.observedAutoCompactions} 次`, `触发点在 ~${human(c.observedAutoTriggerTokens)}（窗口的 ${pct(c.autoTriggerRatio ?? 0)}）`]);
  } else if (s.compactions > 0) {
    ctxRows.push(["压缩实况", `手动 ${s.compactions} 次`, "本场未见自动压缩，均为你手动触发"]);
  }
  if (c.peakSessionNotable) {
    ctxRows.push(["压缩前历史高点", `${pct(c.peakSessionRatio ?? 0)}（${human(c.peakSessionTokens ?? 0)}）`, "本场曾达到的最高占用"]);
  }

  // 链路健康度：把 --request-log 的逐笔归因压成一行结论（明细属于排障，留在 CLI）。
  // 分两档：本会话确实走在代理链路上（proxy/mixed）才印「最近 N 笔」的失败统计与排障命令；
  // token 全来自转录的会话里，那些统计说的是别的会话，印成 warning + 命令是噪音，只留覆盖率与最近记录时间。
  // 纯官方模型用户从没配过代理，整行不渲染。
  const lhRaw = r.linkHealth ?? null;
  const lh = lhRaw && (r.proxy?.configured || lhRaw.matched > 0) ? lhRaw : null;
  const lhOnPath = !!lh && (lh.matched > 0 || lh.usageSource === "proxy" || lh.usageSource === "mixed");
  const lhErrors = lh ? lh.proxyErrors ?? 0 : 0;
  const lhBad = lhOnPath && lhErrors > 0;
  const lhTone: "info" | "warning" = lhBad ? "warning" : "info";
  // 三档拆分一行说清：代理实测 / 转录 input_tokens / 转录 ratio×window 各多少笔。
  // 旧报告（v3）无 breakdown 字段时退回到只报 matched。
  const lhBd = lh?.breakdown ?? null;
  const lhBdText = lhBd
    ? `拆分：代理 ${lhBd.proxy} 笔 · 转录 input_tokens ${lhBd.transcriptTokens} 笔 · 转录 ratio×窗口 ${lhBd.transcriptRatio} 笔`
    : "";
  const lhSrcNote = !lh
    ? ""
    : lh.usageSource === "proxy"
      ? "：全部为供应商实测"
      : lh.usageSource === "transcript-tokens"
        ? "：本会话 token 全来自转录 input_tokens（BYOK，代理未在链路上）"
        : lh.usageSource === "transcript-ratio"
          ? "：本会话 token 由 ratio×窗口推导（官方模型）"
          : lh.usageSource === "mixed"
            ? "：多源混合，以下拆分列为准"
            : lh.usageSource === "transcript"
              ? "：本会话 token 全部来自转录，代理不在链路上"
              : "";
  const lhText = !lh
    ? ""
    : [
        lh.requests > 0
          ? `代理覆盖 ${lh.matched}/${lh.requests} 笔往返（${pct(lh.coverage)}）${lhSrcNote}`
          : "本会话没有带 usage 的往返，代理无从覆盖",
        lhBdText,
        lh.lastRecordAt ? `代理最近记录 ${shortTime(lh.lastRecordAt)}` : proxyAlive ? "代理有记录但无时间戳" : "代理从未记到流量",
        lhOnPath && lh.recentRequests
          ? `最近 ${lh.recentRequests} 笔：代理失败 ${lh.proxyErrors} · 上游报错 ${lh.upstreamRejected} · 客户端提前断开 ${lh.aborted} · 成功但无 usage ${lh.noUsage}${
              lh.slowestMs != null ? ` · 最慢 ${Math.round(lh.slowestMs / 1000)}s` : ""
            }`
          : lhOnPath
            ? "请求诊断日志为空（运行中的代理是旧版，或还没记到）"
            : "",
        lhBad ? `有「代理失败」= 请求没出得去或代理自己抛了，跑 ${CLI} --request-log 看归因` : "",
        !lhOnPath && lhErrors > 0 ? `代理另有 ${lhErrors} 笔失败，属于走代理的那些会话` : "",
        lh.supersededFailure
          ? `${shortTime(lh.supersededFailure.at ?? null)} 那条「拉起失败（${lh.supersededFailure.error}）」已被之后的流量推翻，无需处理`
          : "",
      ]
        .filter(Boolean)
        .join("。") + "。";

  return (
    <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
      <Stack gap="sectionCompact">
        <header>
          <Stack gap="component">
            <H1>会话 token 消耗截析</H1>
            <Text tone="secondary">
              {s.model || "未知模型"}
              {s.modelSource === "manual" ? "（手工录入）" : ""} · {sourceLabel} · 会话{" "}
              {String(s.id || "").slice(0, 8)}
              {s.title ? `「${s.title}」` : ""} · {shortTime(s.startedAt)} →{" "}
              {shortTime(s.endedAt)} · 压缩{" "}
              {availOf(av, "compactions") === "unavailable" ? "—" : `${s.compactions} 次`}
              {r.usageSource ? ` · usage 来源 ${
                r.usageSource === "proxy"
                  ? "代理实测"
                  : r.usageSource === "transcript-tokens"
                    ? "转录 input_tokens"
                    : r.usageSource === "transcript-ratio"
                      ? "转录 ratio×窗口"
                      : r.usageSource === "mixed"
                        ? "多源混合"
                        : "转录"
              }` : ""}
              {r.pluginVersion ? ` · v${r.pluginVersion}` : ""} · schema v{r.schemaVersion}
            </Text>
            <MetricsGrid variant="header" columns={4} items={headline} />
          </Stack>
        </header>

        {!hasUsage && r.source === "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：自定义模型（BYOK）不经 Qoder 计费网关">
            转录是桌面端富布局，但 assistant entry 里没有 message.usage——自定义模型（如千问
            tokenplan）的响应不经 Qoder 计费网关，credits / context_usage_ratio 无来源，提供商返回的
            usage 客户端也不落盘（已实测扫过 ~/.qoder-cn、~/.qoder、~/.qoder-cli 与 %APPDATA%\QoderCN）。
            本地补救（改一个配置文件即可，免装 Node、之后全自动）：编辑 {"`~/.qoder-credits-proxy/config.json`"}，
            把 {"`upstream`"} 填成你的供应商根地址（= Base URL 去掉结尾 /v1），再把自定义模型 Base URL 的 host:port
            换成 {`127.0.0.1:${r.proxy?.port ?? 49787}`}（路径保留），新开一个会话即自动拉起代理、按 message.id
            精确 join 出实测 token（credits 仍无真值）。装了 Node 也可用 {"`--setup-proxy`"} / {"`--check-proxy`"} 一步到位。
            手工回填通道同样可用：
            {"`.qoder-credits/overrides/<sessionId>.json`"}。
          </Callout>
        )}

        {!hasUsage && r.source !== "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：转录不含 message.usage">
            这是 {sourceLabel}（IDE 端客户端）。它的转录只写 session_meta / user / assistant / progress 四种 entry，
            message.usage 整个字段不存在，也不落到本地任何其它文件（已实测扫过 ~/.qoder-cn、~/.qoder、
            ~/.qoder-cli 与 %APPDATA%\QoderCN）。因此 Credits、token 与各类占比一律显示「—」而不是 0 ——
            0 会被误读成「这次没花钱」。真值只有官方 UI 有：把它填进{" "}
            {"`.qoder-credits/overrides/<sessionId>.json`"} 后重跑，上方会出现「官方 UI 真值」一段并与本地并列对账。
          </Callout>
        )}

        {manual && (
          <Callout tone="success" title="官方 UI 真值（手工录入，未覆盖任何本地数字）">
            Credits {manual.credits ?? "—"} · 原价 {manual.originalCredits ?? "—"}
            {manual.model ? ` · 模型 ${manual.model}` : ""}
            {manual.durationMin != null ? ` · 时长 ${manual.durationMin} min` : ""}
            {manual.startedAt ? ` · ${shortTime(manual.startedAt)}` : ""}
            {manual.localCoverage != null
              ? ` · 本地${manual.localScope === "combined" ? "合计（主链+子代理）" : "主链"} ${manual.localCredits ?? t.credits}，覆盖 ${pct(manual.localCoverage)}`
              : " · 本地无 usage，无法对账"}
            {manual.note ? `。备注：${manual.note}` : ""}
          </Callout>
        )}

        {sub && sub.count === 0 && sub.reason && sub.reason !== "no-dir" && (
          <Callout tone="warning" title={`子代理账未汇总（${sub.reason}）`}>
            探测过的候选目录：{(sub.probedPaths ?? []).join("  |  ") || "（无）"}
          </Callout>
        )}

        {proxyAlarm && (
          <Callout tone="warning" title={`代理自动启动失败（${proxyAlarm.error}）`}>
            {proxyAlarm.error === "EADDRINUSE"
              ? `端口 ${proxyAlarm.port ?? "—"} 被占用，自定义模型将无法对话。请换一个空闲端口重启代理：${CLI} --setup-proxy --port <新端口>，并把模型 Base URL 改成新端口。`
              : `代理未就绪（${proxyAlarm.error}），自定义模型可能无法对话。请运行 ${CLI} --check-proxy 查看链路状态。`}
          </Callout>
        )}

        {r.proxy?.dormant && !proxyAlarm && (
          <Callout tone="info" title="代理长期空闲">
            代理已配置但超过 14 天没有记录到流量（可能你已改回官方模型）。如不再使用自定义模型，可运行{" "}
            {CLI} --stop-proxy 停用代理；保留也不影响官方模型。
          </Callout>
        )}

        {cwIsFallback && (
          <Callout tone="warning" title="上下文窗口为回退值 200K（未从 runtime-config / usage 反推 / ManualTruth 拿到真值）">
            本会话所有以窗口为分母的占比与「峰值建议」都可能偏大，而绝对 token 数（已改以 S 真值为底）不受影响。
            建议在 {"`.qoder-credits/overrides/<sessionId>.json`"} 里手工填 {"`contextWindow`"}（如 qwen3-max=1000000），或等一笔带 input_tokens+ratio 的往返写入转录后自动反推生效。
          </Callout>
        )}

        {hasUsage && netAdv && c.userContextLimit != null && (
          <Stack gap="component">
            <Callout
              tone={netAdv.tone}
              title={`你真实的上下文占用 ${pct(c.netUserRatio ?? c.peakUserRatio ?? 0)}（${human(curCtx)} / 阈值 ${human(c.userContextLimit)}・${limitSrcLabel}）`}
            >
              {netAdv.text}
              {limitIsDefault && (
                <Text tone="secondary">
                  {` ⚙ 这里的 ${human(c.userContextLimit)} 是插件内置默认值，不是你在 Qoder「模型管理」里设的真实上限（插件读不到那个设置）。想按真实阈值算：在 ~/.qoder-credits-proxy/config.json 填 "userContextLimit": <你的上限>（对所有会话生效），或对本会话在 .qoder-credits/overrides/<会话id>.json 填同名字段，重跑报告即生效。`}
                </Text>
              )}
            </Callout>
            {ctxRows.length > 0 && (
              <Table
                headers={["对比口径", "数值", "说明"]}
                rows={ctxRows}
                density="compact"
              />
            )}
          </Stack>
        )}

        {c.thresholdNotEnforced && (
          <Callout tone="warning" title="⚠ 自动压缩不会在你设的阈值触发（本条最重要）">
            你的模型物理窗口是 {cwText}，Qoder 的自动压缩要等上下文涨到窗口 ~85%（≈{human(Math.round(c.contextWindow * 0.85))}）才触发；
            你在模型管理里设的 {human(c.userContextLimit)} 上限远在其下，永远不会触发自动压缩。
            请照上面「你真实的上下文占用」那条，到点自己手动压缩，别等它自动压。
          </Callout>
        )}

        {lh && (
          <Callout tone={lhTone} title="链路健康度">
            {lhText}
          </Callout>
        )}

        <Callout tone="info" title="度量口径">
          计费输入总量逐笔锁定真值（优先级：代理 promptTokens &gt; 转录 usage.input_tokens &gt; ratio{availTag(av, "contextRatio")} × {cwText}
          {cwIsFallback ? "，未拿到真窗口、全部 token 数字随之带 ≈" : ""}）；各类别/文件按块估算规模比例分摊
          {availTag(av, "categoryShare", "derived")}。{identityText}
          {cachedText ? ` ${cachedText}` : ""}
          {covPartial
            ? ` Credits 只来自 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}），其余往返走代理实测、不经 Qoder 计费，故不要拿 Credits 去除以计费输入总量算单价。`
            : ""}
        </Callout>

        {byReq.length > 0 && (
          <ReportSection
            title="逐请求明细（每一次往返）"
            description={
              showCreditsChart
                ? "每个 round-trip 的真实输入规模与 credits；曲线骤降处为上下文压缩重置（顶部四项为会话累计，此处为每一次）"
                : `每个 round-trip 的真实输入规模；曲线骤降处为上下文压缩重置。credits 曲线未画：本会话只有 ${cov?.trips ?? 0}/${cov?.roundTrips ?? byReq.length} 笔往返带 credits（其余走代理实测、不经 Qoder 计费），画出来是一地零。`
            }
            meta={`${byReq.length} 次往返 · 压缩 ${orDash(s.compactions, av, "compactions")} 次`}
            divided
          >
            {showCreditsChart ? (
              <ChartComparisonGrid>
                <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                    height={220}
                    valueFormatter={human}
                    ariaLabel="每次请求输入 tokens"
                  />
                </ChartContainer>
                <ChartContainer title="每次 credits" ariaLabel="每次 credits">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "credits", data: reqCredits, tone: "warning" }]}
                    height={220}
                    ariaLabel="每次请求 credits"
                  />
                </ChartContainer>
              </ChartComparisonGrid>
            ) : (
              <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                <LineChart
                  categories={reqLabels}
                  series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                  height={220}
                  valueFormatter={human}
                  ariaLabel="每次请求输入 tokens"
                />
              </ChartContainer>
            )}
          </ReportSection>
        )}

        {hasUsage && ccItems.length > 0 && (
          <ReportSection
            title="压缩单笔成本（会话里最贵的那几笔调用）"
            description="每次压缩本身就是一笔普通模型调用：整份上下文当 prompt 进去、摘要当 completion 出来。此前报告只显示「压缩 N 次」，把单笔最贵的开销藏成了一个计数。「省下」= 压缩前规模 − 压缩后首轮实测输入（地板）。口径列：实测=能在代理日志里唯一对上的供应商真值；自估=客户端在压缩边界里写的前后规模。"
            meta={`${ccItems.length} 次 · 输入累计 ${human(ccost?.totals.preTokens ?? 0)} · 摘要累计 ${human(ccost?.totals.postTokens ?? 0)} · 累计省下 ${human(ccost?.totals.savedTokens ?? 0)} · 其中 ${ccost?.totals.measured ?? 0} 笔为供应商实测`}
            divided
          >
            <Table
              headers={["第几次", "时刻", "触发", "输入", "摘要输出", "压缩后首轮", "省下", "耗时", "口径"]}
              rows={compactRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {sub && subItems.length > 0 && (
          <ReportSection
            title="子代理账（Agent 派发）"
            description="子代理的每次往返只写进它自己的独立转录，不计入上方主链任何数字；官方 UI 的一场会话扣费 = 主链 + 各子代理。"
            meta={`${subItems.length} 个子代理 · 主链 ${t.credits} + 子代理 ${sub.totals.credits} = 合计 ${sub.combined.credits} Credits`}
            divided
          >
            <Table
              headers={["子代理", "类型", "往返", "计费输入", "峰值占比", "Credits", "原价", "备注"]}
              rows={subRows}
              rowTone={subTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && r.byCategory.length > 0 && (
          <ReportSection
            title="按类别占比"
            description={`会话计费输入 token 在各来源间的分布（完整划分，占比之和 = 100%）${sysNote}`}
            meta={human(t.billedInputTokens) + ` tokens${availTag(av, "categoryShare", "derived")}`}
            divided
          >
            <ChartContainer ariaLabel="按类别占比">
              <PieChart donut data={pieData} centerLabel="计费输入" valueFormatter={human} />
            </ChartContainer>
          </ReportSection>
        )}

        {hasUsage && catDetail.length > 0 && (
          <ReportSection
            title="按类别下钻（工具 / 文件路径）"
            description="每个类别的消耗再拆到工具与具体文件/路径：工具返回、工具调用可精确到路径，其余类别为整体（无文件归属）。数值均为重发计费 token。"
            meta={`占总额=占计费输入总量 · 占本类=占该类别 · 程数=存活往返累计${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["类别", "工具", "文件 / 路径", "重发 tokens", "占总额", "占本类", "程数"]}
              rows={detailRows}
              rowTone={detailTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && tools.length > 0 && (
          <ReportSection
            title="按工具占比"
            description="各工具相关内容（调用参数 + 返回）重发累计的计费 token 占比（仅工具相关块，非完整划分，占比之和 < 100%）。「单次」= 平均每次调用带来的重发 token：总量榜会把「次数少但每次极贵」的工具埋掉，这一列专门把它捞出来。"
            meta={`token 占比${availTag(av, "toolShare", "derived")} · 调用次数为实测`}
            divided
          >
            <Stack gap="component">
              <ChartContainer ariaLabel="按工具占比">
                <BarChart horizontal categories={toolCategories} series={toolSeries} valueFormatter={human} ariaLabel="按工具占比" />
              </ChartContainer>
              <Table
                headers={["工具", "重发 tokens", "占比", "调用", "单次"]}
                rows={toolRows}
                density="compact"
                stickyHeader
              />
            </Stack>
          </ReportSection>
        )}

        {hasUsage && fileRows.length > 0 && (
          <ReportSection
            title="按文件占比"
            description="精确到路径/文件名：内容随上下文被重复发送累计的计费 token 占比（Top 20，仅可归因文件的块）。「单次读取」= 这个文件平均每次被读取最终烧掉多少（含此后每一程的重发）——读一次就烧掉十几万的文件，在按总量排序的榜上毫不起眼。"
            meta={`程数=存活往返累计 · 读取=返回次数（实测）${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["文件", "种类", "重发 tokens", "占比", "单次读取", "程数", "读取"]}
              rows={fileRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {!hasUsage && residueRows.length > 0 && (
          <ReportSection
            title="工具调用与文件读取（计数为实测）"
            description="占比与 token 一律不可用，但 tool_use 块两种转录都写，所以「谁被调了几次、谁被读了几次」仍是真值 —— IDE 端不是一无所有。"
            meta={`${t.toolCalls ?? 0} 次工具调用${availTag(av, "toolCalls")} · ${t.fileReads ?? 0} 次文件读取${availTag(av, "fileReads")} · ${s.turns} 轮对话`}
            divided
          >
            <Table
              headers={["工具 / 文件", "种类", "调用", "读取", "程数"]}
              rows={residueRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}
      </Stack>
    </ReportShell>
  );
}
