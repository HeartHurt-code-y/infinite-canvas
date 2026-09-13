# 固定来源与文件清单

- 仓库：<https://github.com/freestylefly/awesome-gpt-image-2>
- 提交：`0dc09c46c8a30b1fdd89c18cc78a894dac2104e3`
- 获取日期：2026-09-13
- 技能路径：`agents/skills/gpt-image-2-style-library/`
- 许可证：MIT，完整版权及许可声明见 `LICENSE`。

以下三份文件均从固定提交下载并保留原字节；`SHA256SUMS` 使用相对于本目录的路径，不包含应用改写文件。

| 应用内文件                    | 上游路径                                                              | 字节数 | SHA-256                                                            |
| ----------------------------- | --------------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `source/SKILL.md`             | `agents/skills/gpt-image-2-style-library/SKILL.md`                    |   2433 | `98519a3bfd28c5ab5630771a536f18fbe3627123cd7dd7a8801fa5da166a60f9` |
| `references/style-library.md` | `agents/skills/gpt-image-2-style-library/references/style-library.md` |  26351 | `4d90087cf1dacf7114d063aa56d3d4a03e0097e52914a0bbce4df77907404dd7` |
| `LICENSE`                     | `LICENSE`                                                             |   1069 | `27a75c48bac29eb78f43c19f75c4e175974c8f1046d848d5562eae1ead2f1176` |

`SKILL.md` 是项目编写的应用合同，运行时与完整 `references/style-library.md` 一起编译注入。原始 `source/SKILL.md` 的示例图片、安装和维护命令仅归档，不进入运行时提示。许可证通过 Tauri 资源映射随安装包分发为 `licenses/gpt-image-2-style-library-LICENSE`，不进入模型提示。

参考文档包含 22 个模板方向、13 个类别、19 个风格标签和 10 个场景标签，属于带用途、指导要点、常见问题和案例编号的索引。来源 `data/style-library.json` 已核对为相同的 22 个索引条目，没有完整提示词正文字段；该 JSON 不打包为运行时依赖。参考文档中的 `docs/templates.md` 链接、封面图片路径和案例编号是来源定位信息，其目标全文或图片不包含在本次技能包中。未把链接或编号冒充已读取内容。

原文件获取地址均使用上述固定提交，而非可变的 `main`：

- [原始主技能](https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/0dc09c46c8a30b1fdd89c18cc78a894dac2104e3/agents/skills/gpt-image-2-style-library/SKILL.md)
- [完整风格索引](https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/0dc09c46c8a30b1fdd89c18cc78a894dac2104e3/agents/skills/gpt-image-2-style-library/references/style-library.md)
- [MIT 许可证](https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/0dc09c46c8a30b1fdd89c18cc78a894dac2104e3/LICENSE)
