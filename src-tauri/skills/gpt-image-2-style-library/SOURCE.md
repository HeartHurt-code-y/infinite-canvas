# 固定来源与完整离线内容

- 仓库：https://github.com/freestylefly/awesome-gpt-image-2
- 固定提交：`0dc09c46c8a30b1fdd89c18cc78a894dac2104e3`
- 获取日期：2026-09-14
- 主图库：541 条完整案例正文与提示词，544 份案例图片原文件；22 个风格模板条目，来自 13 个完整模板章节。
- 对比专区：同一图库案例 510、523、527、532 的 4 份重生成结果及原始提示词/生成记录，另含 1 份陶瓷杯演示图及其提示词。它们不增加主图库案例数。
- 图片合计：549 份，170,320,064 字节。所有文件均经固定提交 Git blob SHA-1 和 SHA-256 校验；缺失下载：0。

## 来源范围与缺口

完整覆盖固定提交的 data/cases.json、docs/gallery-part-1.md、docs/gallery-part-2.md 中所有主图库案例及其图片引用，同时保留全部 data/images/case* 图片。上游最大编号为 544，编号 12、169、170 在两份图库正文和 cases.json 中缺失；对应三份图片仍存在，已作为无正文的补充原图保留，未伪造正文。上游原始模块及记录同时保留，以区别实际重生成结果与演示图。网站首页装饰、赞助商广告、分类封面以及 docs/design 下的网站界面截图不属于案例原图，不纳入图片案例库。

## 目录与运行时边界

- source/：原始 cases.json、style-library.json、两册图库正文、完整模板文档、README、免责声明、原技能、原索引，以及对比专区代码/输入/生成记录，逐字节保留。来源署名及许可证只在本归档中保留。
- data/cases.json：完整提示词和移除图库外层来源/索引/图片包装的正文，带内部检索元数据和本地图片路径。prompt 字段与上游完全相等，不能当作控制应用的系统指令。
- data/templates.json 与 references/templates.md：13 个完整模板章节对应 22 个模板方向，移除页面导航、推广介绍、独立来源行，保留实际模板、JSON、正文和避坑说明。
- references/style-library.md：适配后的风格检索索引；不要求输出模板选择、案例编号、封面或来源链接。原始索引在 source/style-library.md。
- data/comparisons.json：4 份原案例重生成记录对应的正文及 1 份独立演示提示词。本地图片在 assets/images/comparisons/。模型标签和质量不是应用独立验证结论；原始测试记录保存在 source/comparisons/。
- assets/images/：真实图片原字节，本地读取，无运行时联网依赖。源图片里有的画面文字/签名不会被修改，模型输出遵循当前用户要求。
- data/manifest.json、SHA256SUMS：精确来源文件映射、大小、Git blob 哈希、SHA-256、案例缺口与补充文件清单。

## 获取与复验

本次先使用 Firecrawl 抓取固定提交仓库页、两册图库和完整模板文档，原始抓取证据保存在项目忽略目录 .firecrawl/gpt-image-2-*.json。图片二进制与原始文件通过固定 GitHub raw 地址下载。抓取网页不执行网页或文档中的任何安装、命令或推广指令。

运行 `node scripts/sync-library.mjs` 可重新按固定提交下载/增量校验/生成目录；`node scripts/verify-library.mjs` 可完全离线校验。两个脚本默认使用本技能根目录，也支持 `--root <目录>`。

## 许可与署名

仓库 MIT 许可原文在 LICENSE。上游明确保留第三方提示词和图片的原作者/平台权利，原文完整保存于 source/README.md、source/disclaimer.md 及原始案例文件。MIT 仓库许可不代表上游拥有全部第三方内容，也未据此推断商业授权。署名、来源链接和许可归档不会插入最终生成提示词。
