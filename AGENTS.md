# 任务完成标准

- **任务完成 = 「编译」+「真实开发环境端到端验证」两样都做完**：交付前先跑编译器（前端 `pnpm typecheck`（`tsc --noEmit`，覆盖 `tsconfig.json` 与 `tsconfig.node.json` 两份）、Rust `pnpm rust:check`（`cargo check`）），再在**真实开发环境**里把这次的改动真正跑通，看**实际结果**而不是「应该没问题」。两样都过才算完成；只编译不验证、只验证不编译，都不算完成。
- **端到端验证要「真的跑」，不是「读代码觉得对」**：优先在**应用自身**里操作（桌面应用直接开起来点，别另起浏览器预览）；涉及外部服务的改动要**真实调用**——真的发一次生成请求、真的看返回与产物、真的确认落盘与报错文案。**允许产生实际费用**（用户明确授权），但要如实说明跑了哪几次、花在什么上。
- **验证层级要如实标注**：端到端验证分三层——① 应用内 UI 全链路；② 应用自身代码路径触发的真实请求（例如在应用里发起的生成、真实轮询、真实落盘）；③ 协议层直打真实端点（绕开 UI，直接按应用真实产出的请求体形状调用供应商）。③ 不能替代 ①②，替代了要在交付说明里写明「未走 UI 路径」。**不允许**把「协议层打通了」写成「端到端验证通过」。
- **验证要覆盖本次改动的实际落点**：改了哪条路径，就在那条路径上验证；改的是错误分支就触发那个错误分支（不能只跑成功路径），改的是参数契约就用真实参数跑一遍。看实际结果（实际请求体、实际响应、实际产物、实际错误文案），而不是「代码逻辑上应该会……」。
- **编译器是最低门槛，不是全部**：编译器只看类型。测试套件 / eslint / knip / prettier / clippy / 前端构建 / Tauri 打包 / `pnpm codegen` 仍然**一律不跑**（见「测试约定」）。这些免掉的检查正是「端到端验证」必须自己扛起来的理由——编译器看不见的那类问题只能靠真机跑一遍看出来。
- **审查与修复要按范围收敛**：仓库里可能同时存在用户自己在改的未跟踪模块（本项目常见于 `src/features/create/`）。这类文件的报错要**归因并如实说明**，**不要代改**（会冲掉进行中的修改）。改动范围之外的问题只说明，不顺手重排无关代码。
- **交付说明必须如实写清两件事**：① **端到端验证到底跑了什么**（在哪跑的、点了什么、真实请求/生成跑了没有、结果是什么）；② **编译器跑没跑、结果如何**。**没跑就说没跑，没验证就说没验证**——不要把「应该没问题」写成「已验证」。修复了别人的前置失败要写明归因。

# 画布节点交互约定

- **说明气泡（tooltip）统一由 `src/components/TooltipLayer.tsx` 提供**：触发器上写 `data-tooltip="文案"` 即可，不要再写自己的 CSS 伪元素。该层挂在 `App.tsx` 根部（**错误边界里面**——它自己出问题要由边界兜住，挂在外面则整个应用白屏、连报错页都看不到），用**事件委托**接管全应用的 `[data-tooltip]`（画布节点会被 React Flow 反复重渲染，逐个挂监听既啰嗦又容易漏），并把气泡 **portal 到 `document.body`**（`position: fixed`）。
- **为什么不能退回 CSS 伪元素**（`[data-tooltip]::after`）：伪元素**永远朝下**展开（`top: calc(100% + gap)`），贴底的控件组（画布左下控件组 `.canvas-viewport-dock`、底部浮坞）下方没有空间，说明被视口下沿切掉；伪元素还挂在触发器内部，会被祖先的 `overflow: hidden`（`.canvas-stage`）裁掉，也量不到自己的宽度（长文案无法在视口右沿夹住），还会跟着 React Flow 的缩放层一起缩放。
- **定位必须用实测宽高**：翻面判断（「下方装不装得下」）与水平夹取都依赖气泡的**实测尺寸**，不能用估算值——估算偏小会让下方明明放不下却判定放得下，说明照样被切掉。计算统一走 `src/components/floatingLayer.ts` 的 `placeTooltip`，与画布节点菜单、创作台浮层共用同一套「实测尺寸 + 不越出视口」规则，不另写一份。
- **读屏描述与视觉气泡必须是两个元素**：`aria-describedby` 的语义是「该控件的**稳定**描述」。若直接指向视觉气泡会有三个故障：气泡是共享的、内容随 hover 改写（焦点在 A、鼠标悬停 B 时 A 会念出 B 的文案）；hover 路径会给**非焦点**元素挂引用（描述只在聚焦时有意义）；气泡隐藏时清空内容，焦点元素的描述就指向了空元素。所以视觉气泡标 `aria-hidden="true"` 只管视觉，读屏描述是另一个常驻的 `sr-only` 元素（id 由 `useId()` 生成，见下一条），内容跟随**当前焦点**的触发器——与仓库既有范式一致（`MediaNodeViews` 的 `<span id={promptHintId} className="sr-only">`）。描述元素必须**常驻 DOM**：焦点那一刻它若不存在，读屏就读不到。
- **只有说明提供了可访问名之外的信息时才挂 `aria-describedby`**：全应用有 7 处触发器的 `data-tooltip` 与 `aria-label` 完全相同（如「切换小地图」），另有 3 处说明是**可访问名的子串**（「打开素材库侧板」配「素材库」、「打开创作台」配「创作台」、「打开全局设置」配「全局设置」）——名字念完那句话也就说完了，再挂一次描述是同一句话念两遍，那是噪声不是信息；而「功能组件（后端暂未接入）」「整理画布 · Alt+Shift+F」「清空画布上的节点与连线」这类**只有 tooltip 里有的信息**必须关联，否则读屏用户永远拿不到。判据是「可访问名有没有把说明这句话说完整」：**说明被名字逐字包含 → 不挂**；说明比名字更长 → 挂。**描述要挂在真正获得焦点的那个元素上，不是挂在触发器上**——`aria-describedby` 不向下继承，挂在祖先上等于没挂（今天 26 处触发器都是叶子 `button`、焦点元素恰好就是触发器，属于「恰好成立」而不是「设计上成立」，别依赖这个巧合）。关联要放在 **`useLayoutEffect`**（提交阶段同步执行）而不是 `useEffect`：读屏通常在焦点事件那一轮就查询控件的描述，而被动副作用排到 paint 之后才跑的话，属性还没挂上，描述就漏掉了。触发器若原本已有 `aria-describedby`（如 `CanvasSelect` 的错误提示），要**追加**；失焦时**只摘掉自己挂的那个 id**，不要整串还原成挂载前的快照——期间别人可能又加了引用，整串还原会把那一条一起抹掉。关联用的 state 更新要**幂等**（同一锚点、同一文案、**同一描述宿主**时复用上一次的 state 对象）：否则每次 focusin 都会让 effect 重跑一轮，cleanup 先移除 `aria-describedby`、再重新加上，中间那个窗口里读屏查询描述会拿到空值；而只比锚点与文案会漏判「同一触发器内焦点换了子元素」——描述会留在旧宿主上。描述元素的 id 用 **`useId()`**（与 `CanvasSelect`、`SearchableMultiSelect` 一致），不要手写常量——手写常量在挂了两个实例时会撞 id，读屏会引用到错误的元素；React 生成的 id 带冒号（`:r0:`/`_r_0_`），在 `aria-describedby` 里合法且能被可访问性树正确解析（已实测）。
- **指针与焦点是两条独立的状态源**：焦点离开时若指针仍指着触发器，不该隐藏；指针离开时若**键盘来源**的焦点还留在触发器上，也不该隐藏。判断「指针是否还在上面」要用 `elementFromPoint` + 最后已知指针坐标，**不要用 `:hover`**——Chrome 里 `:hover` 不匹配 disabled 元素，而本项目有不少置灰按钮带 `data-tooltip`。
- **「焦点还留着说明」只认键盘来源的焦点**：鼠标点过按钮后焦点就落在按钮上，若用 `contains(document.activeElement)` 判定「焦点还在就别隐藏」，指针一移开说明就永远赖在屏幕上（粘住的气泡）。焦点来源要在**聚焦那一刻**定下来（`focusin` 时记下当时的输入设备），不能等隐藏时再去看「最近一次输入设备」——用户 Tab 到按钮后又用鼠标点了别处，最近输入设备变成指针，但那个焦点确实是键盘落在按钮上的。用鼠标点了当前键盘聚焦的触发器时，要撤掉「键盘持有」（等价于 `:focus-visible` 的行为）。
- **只有键盘来源的焦点才给「视觉气泡」**（读屏描述不受此限）：鼠标点击按钮同样会派发 `focusin`，若一并响应，用户点一下按钮就冒出一段说明（旧实现用 `:focus-visible` 正是为了避免这个）。**`:focus-visible` 不能直接用**：实测鼠标点击一个此前被键盘聚焦过的按钮后，`:focus-visible` 仍为 `true`——它反映的是「上一次交互方式」而非「这一次」。所以自己追踪最近输入设备（`keydown` 记为键盘、`pointerdown` 记为指针），这是 UI 库（Radix / React Aria）的标准做法。
- **读屏描述始终跟随「实际焦点」，与焦点来源无关**：元素确实是当前焦点，描述它就是对的（读屏 + 鼠标的用户同样需要）。若按输入来源跳过更新，焦点从 A 移到 B 时 `focused` 会仍指向**已失焦的 A**，A 的 `aria-describedby` 残留——那是陈旧状态。焦点移到另一个触发器时**不要**抢先清空描述（清空会让 `aria-describedby` 先被撤除再重新挂上，中间那个窗口里读屏查询描述会拿到空值），交给紧随其后的 `focusin` 更新；但新焦点若是**没有说明**的触发器（`data-tooltip` 为空），`focusin` 会提前返回，描述就会永远停在旧元素上——这条路径要在 `focusout` 就清掉。
- **Escape 关闭后，指针没离开该触发器时不应复活说明**：否则用户会以为 Escape 没用——指针在按钮上微动一下，说明就回来了。要记住被关掉的那个触发器，直到指针**真正离开**它才解除屏蔽。注意屏蔽只针对**指针路径**：键盘聚焦是另一次明确的交互，照常给说明（否则纯键盘用户一旦误按 Escape，就再也拿不到那个控件的说明了——屏蔽的解除条件是指针离开，键盘用户可能一辈子不动鼠标）。
- **气泡定位写 `transform` 而不是 `top/left`**：`transform` 走合成器不触发重排；写 `top/left` 会让浏览器每帧重新布局气泡，在大画布上是明显的 layout thrash。跟随触发器用低频定时器（`FOLLOW_INTERVAL_MS`）而不是 rAF 每帧轮询——画布平移走 transform、没有对应事件，只能轮询，而每帧 `getBoundingClientRect()` 会**强制同步布局**。
- **水平夹取不能写成 `min(max(margin, centered), max(margin, vw - w - margin))`**：气泡比视口还宽时两个边界大小关系会反转，结果取到下界、气泡照样溢出视口。`placeTooltip` 里已显式分两种情况处理。视口宽度要用 **`documentElement.clientWidth`**（不含滚动条）而不是 `window.innerWidth`：`position: fixed` 的包含块是**视口可见区**，实测有 15px 滚动条时 `innerWidth` 是 1000 而 fixed 元素右沿只能到 985，用 `innerWidth` 夹取会让气泡压到滚动条上。纵向仍用 `innerHeight`——`documentElement.clientHeight` 在根元素自身可滚动时是**内容高度**（实测 3000），用它会把气泡算到屏幕外。
- **触摸设备不响应悬停**：触摸点一下会派发 `pointerover` 却**不派发** `pointerout`，气泡会粘在屏幕上不消失。用 `event.pointerType === "touch"` 直接忽略（比旧的 `@media (hover: hover)` 更精确：混合设备上鼠标照常用）。
- **触发器可能已经不可用了**，有两种形态：从 DOM 里消失（画布节点被删、React 重渲染替换了按钮）→ `isConnected` 为 false；还在 DOM 里但被藏起来（`display: none` 的容器、响应式断点下隐藏的控件）→ `isConnected` 为 true 但矩形全为 0。两种情况下 `getBoundingClientRect()` 都拿不到有效位置，气泡会被摆到视口左上角并一直停在那儿——比不显示更糟。定位前必须同时查 `isConnected` **和**矩形宽高。更可靠的是**事件驱动**：浏览器在元素消失时**不会**派发 `pointerout`，只派发一次 `pointerover`（落在 body 上）——所以「指针落到不带 `data-tooltip` 的元素上」这条路径必须收掉气泡，不能直接 return。只靠定时器检测卸载时机不可靠（机器繁忙时定时器会被推迟，检测就晚了）。
- **触发器被别的东西盖住时也要收掉气泡**：气泡渲染在 body 上、层级是 `--z-tooltip`（600，全应用最高），比展开的提示词编辑器（`--z-modal`，400，全屏 + scrim）还高。编辑器一打开就把 `.workspace-shell` 置为 `inert`，而 `inert` 子树不接收指针事件——**指针不动就不会再有 pointerover/pointerout**，气泡会浮在模态之上一直挂着。事件驱动救不了这一种，要在每轮跟随里做命中测试兜底：触发器中心那个位置上若不是它自己、它的后代或它的祖先，就说明它被盖住了，收掉气泡（气泡自己是 `pointer-events: none`，不会成为命中目标）。
- **指针移出又立刻移回要取消「待隐藏」定时器**：否则气泡会在指针明明停着的时候消失（`pointerover` 命中同一触发器时不能直接 `return`，要先清隐藏定时器）。
- **换了触发器要把上一个的气泡收掉**：旧气泡描述的是上一个控件（箭头还指着上一个），留在屏幕上会误导；旧实现（CSS 伪元素）本来就是指针移开时 120ms 淡出的，保持一致。注意 `hide()` 会连带清掉「待显示」定时器，所以**必须排在重新计时之前**。例外：旧气泡若是由**键盘焦点**持有的（焦点还停在那个控件上），就留着——它描述的仍是当前焦点控件，等新气泡显示出来再替换，新气泡也走了之后「焦点持有」的恢复逻辑会把说明还给焦点控件。
- **Escape 要关掉当前显示的那一条说明**，不要 `preventDefault`/`stopPropagation`：Escape 在本项目里是关闭弹窗与菜单的通用键（`CanvasSelect`、`SearchableMultiSelect` 都监听它），本层不该抢掉那些行为；只关视觉会留下「半关闭」状态——描述还在、焦点没变、也不会再有 `focusin` 来刷新它。但读屏描述**只在它属于同一个触发器**时才一起关：焦点在 B、鼠标悬停 A 时按 Escape，被关掉的是 A 的气泡，B 仍然聚焦着，把 B 的说明也抽走会让读屏用户丢掉当前控件的说明。
- **Escape 的屏蔽必须「先记再隐藏」**：`hide()` 会把 `anchorRef.current` 置空，先隐藏再读就永远读到 null，被关掉的触发器根本没被记住，屏蔽机制等于没写（指针一动说明就复活，Escape 看起来"没生效"）。记住后在指针**真正离开**该触发器前不再显示它；等待显示的定时器回调里也要再确认一次（不要只依赖 `hide()` 顺带清定时器这种隐式保证）。
- **Escape 处理要先判输入法组合状态**（`event.isComposing || event.keyCode === 229`）：组合期间的 Escape 归输入法（取消候选窗口）。本项目所有 Escape 处理都遵循这一条（`CanvasNodeEditor`、`PromptNodeViews`、`VideoNodeSettingsControls`、`NodeNameEditor`、`DocumentNodeViews`），浮层这层也要跟：漏掉会造成用户在提示词编辑器里按 Escape 取消候选时，顺手把画布上的说明也关掉了，而那一处还会被记成「被 Escape 关过」。
- **已经被别人认领的 Escape 不再动作**（判 `event.defaultPrevented`）：本项目的 Escape 消费者（`CanvasNodeEditor`、`CanvasSelect`、`SearchableMultiSelect`）都会 `preventDefault()` + `stopPropagation()` 认领这个键；「关掉下拉菜单的 Escape」不该顺手把画布上的说明也关掉、还给那个触发器记上一笔「被 Escape 关过」（指针没离开前它的说明再也不出现）。因此 **Escape 的处理必须挂在冒泡阶段**——捕获阶段还没有人处理过，`defaultPrevented` 恒为 false；而**「记录输入来源」的 keydown 监听仍要留在捕获阶段**，因为有些控件会 `stopPropagation()` 掉 keydown（`CanvasNodeEditor` 关闭编辑层时就会），冒泡阶段收不到 → 焦点来源会被误判成指针，键盘聚焦的说明就不出来了。两个监听各司其职，不要合并成一个。
- **指针离开所有触发器时必须取消「待显示」定时器**：说明有 800ms 的显示延迟，指针在延迟到期前就移开的话，那次延迟结束仍会把说明弹出来——指针明明不在按钮上，屏幕上却冒出一条说明；而且此时已经没有 `pointerout` 可以收它了（气泡的锚点不是当前指针所在的那个触发器），它会一直挂在那儿。所以「指针离开所有触发器」这条路径要同时做两件事：取消待显示 + 安排隐藏。`focusout` 路径**不能**取消待显示——焦点挪走时指针可能还停在某个触发器上，那条说明还得照常出现。
- **Escape 也要记住「延迟中」的那个触发器**：气泡还没显示（还在 800ms 延迟里）时按 Escape，`anchorRef` 是空的，只记 `anchorRef` 等于没记——那次延迟中的说明会在 Escape 之后照样冒出来，Escape 看着像没生效。要单独记「待显示」的锚点。
- **悬停延迟保持 800ms、键盘聚焦立即出现**：这是旧伪元素实现定下的节奏（`transition-delay: 800ms` / 聚焦 `0ms`）。改这个数值属于**改交互节奏**而不是修 bug——修「说明被视口切掉」时不要顺手改时长。
- **说明文案可能自己变**：触发器可以在状态变化时改写自己的 `data-tooltip`（如切换模式的按钮在「移动 · 拖动画布」↔「框选 · 框选节点」之间切换、工具条项的「（后端暂未接入）」后缀随能力状态出现或消失）。说明若停在旧文案上，用户读到的是一句**已经失效的话**——比不显示更糟。定位的每一轮跟随都要**重读触发器的 `data-tooltip`**并与当前显示的文案比对，不一致就换文案、按新文案重测尺寸再定位；文案被清空（属性被摘掉）则收掉气泡。**读屏描述同样要跟着换**：它读的是**焦点那个控件**的属性（与当前气泡挂在谁身上无关——焦点在 B、悬停 A 时两者可以是不同元素），否则屏幕上的说明与念出来的说明会不一致。
- **画布节点里的下拉（供应商、模型、参数枚举、任务类型、素材角色）一律用 `src/components/CanvasSelect.tsx`，不要再用原生 `<select>`：原生弹层由浏览器画在 React Flow 缩放层之外，WebView2/WKWebView 的非整数缩放下点击经常落空，用户要点好几次甚至切不动。`CanvasSelect` 的菜单挂在 body 上，点击必然落位。
- 节点设置面板（`VideoNodeSettingsControls`）的「点外部关闭」判断要放过 portal 出去的浮层（如 `.canvas-select__menu`），否则 capture 阶段先关面板，菜单随面板卸载，选项点不中。
- **「引用该节点生成」的入口是手柄**点按**，不是拖拽**：React Flow 12.11 的手柄只在指针位移超过 `connectionDragThreshold`（默认 1px）之后才派发 `onConnectStart` / `onConnectEnd`——纯点按一个手柄，RF 一个事件都不发，连 `onConnectEnd` 都没有。所以「点手柄弹菜单」这条路径必须自己接：在 `document` 上用**捕获阶段**的 `pointerdown` / `pointerup` 识别 `.react-flow__handle`（RF 在手柄 div 上写了 `data-nodeid` / `data-handleid`，节点与端口都读得到），点按即弹「添加节点」菜单。**位移阈值必须与 `handleConnectEnd` 对齐（4px）**，否则同一次手势会同时弹出两个菜单、落点随机。拖拽仍然是连线手势，两条路径互斥（拖拽结束时的 click 落在 mousedown 与 mouseup 的**共同祖先**上）。别把回调挂进节点视图：节点视图被 `memo` 包着，挂回调会让每个节点的 `data` 引用都变、缓存全失效。
- **手柄的键盘路径不能缺**：手柄命中区在节点外侧 80px、纯鼠标手势，键盘用户原本完全够不到「引用该节点生成」。手柄只在**节点被选中时**进 Tab 序列（`CanvasFlowViews` 按 `selected` 给 `tabIndex`），焦点落在手柄上按 Enter / Space 等价于点按；处理时记得 `preventDefault` **并 `stopPropagation`**——React Flow 的节点包装层把 Enter / Space 当成「选中节点」，不拦住的话编辑层会展开、盖住建在旁边的新节点。鼠标路径同理：点手柄后紧接着的那一次 click 要拦掉，否则节点会被选中。
- **方向按端口语义走，报错文案不能讲反**：输出端口（右侧）=「引用该节点生成」，新节点摆在被引用节点的**左边**，边是「原节点 → 新节点」；输入端口（左侧）=「接入该节点」，新节点摆在右边，边是「新节点 → 原节点」。本项目画布从左往右流，**左侧是输入端口**——拿它讲「引用该节点生成」方向是反的（曾有一句报错让用户去点左侧手柄，而那个入口当时根本不存在，用户点下去毫无反应）。
- **生成节点的「参考素材」不需要后端**：图片节点与视频节点共用 `src/features/workspace/CanvasReferenceTools.tsx`（上传本地素材 / 从画布上挑一份已存在的素材），素材入库走本地素材库、连线走画布 store，全程前端闭环。别再给它挂「后端暂未接入」的 toast——那条链路没有后端依赖。
- 提示词内容存在提示词模块（`promptContents`）里，**不进画布 store**，所以内容变化不会触发 store 订阅里的落盘。改字必须显式排期落盘（`scheduleCanvasSaveRef`）：节点卡里的编辑器靠 `input` 事件冒泡到画布视口触发排期，而独立编辑区（视口之外）的冒泡到不了视口，只靠那一条会丢掉独立编辑区里改的字。
- **提示词住在 `promptContents` 的节点类型，必须显式进 `collectCanvasDocument` 的快照 key 集合**（`promptContents.snapshotAll(keys)` 只快照给定 key）。漏掉时排期与落盘都"正常"，但存出来的画布文档里没有这段提示词，重新打开就丢了——智能剪辑节点（`videoClipNodes`）就是这么漏过一次，提示词节点（`gen` 的 `kind: "prompt"`）也漏过一次。复制粘贴走 `document.promptContents` 按 key 过滤（通用），所以只要存进文档，复制就自动带上。
- **快照 key 集合不再按节点类型登记，改成「画布里现存的节点 key」**（`WorkspaceApp.tsx` 的 `collectCanvasDocument` 用 `useAllCanvasNodeKeys()` 求交集）。此前靠「`gen` + `videoClip`」两份手工列表推导，而那份登记表与真正的注册点（`PromptMentionInput` 挂载处）**没有任何编译期关联** —— 已经因此丢过两次提示词，且症状最难察觉（排期与落盘都正常，只是重开丢了 @引用的素材身份绑定与粘贴附件，纯文本有 `config` 镜像所以不丢）。**新增任何注册 `PromptMentionInput` 的节点类型不需要再登记任何地方**，天然被覆盖。

# 提示词编辑器约定

- 提示词编辑器不再提供富格式工具栏：格式按钮与「插入媒体文件」选择器已整体移除，编辑器只保留纯文本输入与 @ 引用。富文本标记仍由内容模型承载（历史文档里的加粗/标题照常显示），Ctrl+B 等键盘快捷键仍可用。
- **canonical 文档里，标题、列表项、引用、代码块、分割线各自占一条独立条目**；普通段落才靠条目内的 `\n` 分隔。往 canonical 重建文档时**只有普通段落可以跨条目合并**（`appendStyledText`）：合并块级条目会把相邻列表项焊成一条（反向转换每条只生成一个 `listItem`，两个列表项于是塌成一个）、同级标题并成一段、有序列表编号少算一项。空文本只有分割线（`block: "hr"`）需要保留，其余空串直接丢弃。
- **`appendStyledText` 的两种合并语义必须分开**（`options.mergeWithinBlock`）：跨条目重建（存档解码、引用解析的扁平合并）时块级条目**不**合并；但**同一个块内部**的行内片段与软换行（`Shift+Enter`）必须并成**同一条**——块内片段与「相邻两个块」在样式上完全相同（同样 block、同样 marks），只能靠「这是该块专属的 sink」这个上下文区分。不区分就会把「列表项里按 Shift+Enter」拆成多条，反向转换时一个列表项裂成三个（其中一个只含一个换行）、有序列表编号错位，**存盘后结构永久损坏**。`promptTiptap` 的 `walkInline` 必须传 `mergeWithinBlock: true`。
- **`plainText` 是 `segments` 的界面镜像，两者必须一致**。发给供应商的文本走 `segments`（Rust `media.rs` 逐段 `push_str`，段间没有分隔符），只给其中一边补换行会让「用户看到的」与「模型收到的」不是同一份文本。
- 附件走粘贴与拖拽进入提示词（`onPaste` / `onDrop` → `ingestAttachmentFiles`）；没有文件选择器入口后，别再引入只依赖选择器的附件路径。

# 项目发布约定

- macOS 构建与更新发布不要求 Apple 公证；不要因缺少公证凭据暂停发布，也不要在每次发布时重复询问。
- 没有 Developer ID 证书时，沿用项目的 ad-hoc 签名方案。发布前仍须校验应用包签名、Tauri 更新签名、版本和实际产物。
- 发布说明须告知用户未经公证的包可能被 Gatekeeper 拦截，并提供 `scripts/install-macos.sh` 的首次安装指引。
- 只有用户明确改变要求时，才把 Apple 公证加入发布流程。
- **vendored 第三方源码必须随仓库提交**：`src-tauri/vendor/`（当前是打了补丁的 wry 0.55.1）被 `src-tauri/Cargo.toml` 的 `[patch.crates-io] wry = { path = "vendor/wry" }` 当作**构建期 path 依赖**引用。它不进版本库时，干净检出的机器上连 `cargo metadata` 都会直接失败（`error: failed to load source for dependency 'wry'`），CI 与本地打包全部红。该目录**不要**加进 `.gitignore`；补丁内容与理由见 `src-tauri/vendor/wry/VENDORED-PATCH.md`。

# 项目组件分发约定

- **「功能组件」按需下载机制已整体下线**：顶栏入口、`src/features/workspace/RuntimeComponentsPanel.*`、`src/lib/runtimeComponents.ts`、组件目录 JSON（`src-tauri/resources/component-catalog.json`）、下载/校验后端命令（`component_manager.rs` / `component_download.rs` / `component_archive.rs` / `runtime_components.rs`）、组件打包脚本（`package-runtime-components.mjs`）与 TOS 组件上传路径、CI 里的组件任务都不再保留。Windows slim 安装包（`tauri.slim.conf.json` 与对应 NSIS 模板）随之删除——它的存在前提就是「不打包 ffmpeg，改由运行时下载组件」。
- **FFmpeg 改为随安装包内置**：`src-tauri/resources/ffmpeg/` → 安装包 `ffmpeg/`，由 `pnpm ffmpeg:prepare` 在构建前准备。视频合成、抽帧、下载转码照常可用，运行顺序是「系统 ffmpeg → 内置资源 → 官方构建回退」。不要因为组件面板消失就动这条内置路径。
- **签名资源更新是另一个功能，必须保留**：`scripts/runtime-resource-baseline.mjs`、`scripts/runtime-resource-release.mjs`、`src-tauri/src/backend/resource_update.rs` 与前端 `src/lib/appUpdate.ts` 的资源补丁流程更新的是应用自带资源，与「功能组件」无关，不要连带删除。
- 已整体删除三个大型运行时组件及其功能：`blender`（白模渲染）、`remotion-runtime`（动画渲染与网页视频解析）、`pose-runtime`（动作捕捉）。对应的功能特性 `white-model-render`、`animation-render`、`browser-download`、`motion-capture` 一并移除，Rust 后端、前端、构建脚本与 CI 中都不再保留对应分支。
- 已整体删除另外三个组件：`gpt-image-2-style-library`（图片风格库，连同提示词节点的「GPT Image 2 风格库」模式 `gpt_image_2_style` 与技能包 `src-tauri/skills/gpt-image-2-style-library/`）、`ai-media-runtime` 与 `ai-media-quality-runtime`（AI 媒体深度估计与人声/背景音分离，含 `AiMediaPanel`）。对应特性 `image-style-library`、`ai-media-lite`、`ai-media-quality` 一并移除。
- 白模导演台（3D 视口、时间轴、检查器）、站位图导出与白模渲染任务随之删除，`whiteModelStudio` 节点配置字段不再读写；Rust 侧的 `save_white_model_still` 命令一并移除。
- 本地产物的 origin 枚举 `white_model` / `white_model_still` / `ai_media` 保留，让历史画布里的旧白模与 AI 媒体产物仍能正常渲染和作为本地文件连入生成；只删能力，不删旧数据标识。
- 「专业级白模控制」仍然保留：它只把画布上已有的视频／图片节点编译成 Seedance 2.5 的冻结提示词，不依赖任何本地渲染组件。相关代码在 `src/lib/whiteModelControl.ts` 与 `src/features/workspace/WhiteModelControlSection.tsx`，改动这两个文件时不要误删。
- 全景图（panorama）能力与白模无关，代码在 `src/lib/panorama.ts`，不要与白模代码一起删除。
- 删除组件时，同时删除因此失去唯一入口的功能（例如 `pose-runtime` 只有白模导演台一个入口，删掉 Blender 后动作捕捉即成空壳），不要在组件面板里留下装完却用不了的条目。
- 删除组件时同步清理 `package.json` 里因此失效的依赖：CI 有 `pnpm knip` 门禁（未使用依赖检测），删了组件却留着依赖会让 CI 直接红。删依赖后要跑 `pnpm install --lockfile-only` 更新 lockfile（CI 用 frozen lockfile 安装）。
- 删除前先查共享代码：白模场景模型曾同时供白模渲染与站位图使用，删渲染器不等于删整块模块；与被删组件无关的能力（如专业级白模控制、全景图）要保留并单独成模块。

# 工作流功能约定

- 「工作流仓库」及其 11 类自动工作流（知识视频、AI 影视、漫剧、电商、品牌视频、MV、Remotion、小红书封面、产品场景图、短视频反推、视频拉片）已整体移除，前端、Rust 存储、提示词模式与对应 skill 包都不再保留；不要在没有用户明确要求时重新引入这套机制。
- 画布仍保留通用能力：素材、生图／生视频、提示词（文本）、剧本创作、视频合成（智能剪辑）与创作台。数字模特库、品牌设计工作台等非工作流功能不受影响。
- **数字模特库与品牌设计工作台的 Rust 命令仍在线**（`list_brand_models` / `save_brand_model_version` / `approve_brand_model_version` / `validate_brand_model_version` / `archive_brand_model` / `read_brand_design_image` / `export_brand_design_bundle`，见 `src-tauri/src/lib.rs`），前端客户端 `src/lib/brandModels.ts` 与 `src/lib/brandDesignClient.ts` 也保留。它们的 UI 入口原本只挂在已下线的工作流面板上（`BrandVideoWorkflowSections` / `ProductSceneWorkflowSections`），工作流下线后**当前没有入口**——这是待补的独立功能入口，不是死代码：`knip.json` 的 `ignore` 里显式豁免了这两个文件，**不要当死代码删掉**，也不要因为「knip 报未使用」就顺手移除豁免。
- **`src/lib/bindings/**` 是 ts-rs 生成物**（由 `pnpm codegen` 产出），不是手写源码：Rust 侧类型删了但绑定文件仍在是正常的（下次 codegen 会清），反过来手删绑定文件也会被 codegen 重新生成。`knip.json` 已整目录豁免。
- **画布的节点类型清单与 liblib.tv 画布逐项对齐**（逆向规格 `docs/integrations/liblib-canvas-re.md` 第 3.3 节）：文本 / 图片 / 视频 / 智能剪辑 / 导演台 / 逐帧拉片 / 音频 / 剧本 / 参考节点。原站没有的节点类型（网络爆款视频下载 / 视频抽帧 / 爆款视频复刻）**已删除**，不要再加回来；原站有而本项目后端尚未提供的（导演台 / 逐帧拉片 / 参考节点）保留条目与文案，点击给出「后端暂未接入」的明确说明，不静默失败。**音频节点已接入**（见「音频节点约定」）。
- 历史数据不做兼容：旧画布里的工作流节点直接丢弃，Rust 侧 `workflow_history` 表不再读写。

# 已下线功能约定

以下四块功能已整体删除，前端、Rust 后端、构建脚本、CI 与 skill 包都不再保留对应分支；没有用户明确要求时不要重新引入：

- **故事板**：顶栏「故事板视图」面板与投影逻辑（`CanvasStoryboard.*`、`storyboardProjection.ts`、`useStoryboardTaskArchive.ts`）、提示词节点的「故事板」(`storyboard_prompt`) 与「多宫格分镜」(`multi_grid_storyboard`) 两个技能模式、画布节点「剧本转工业级分镜脚本」(`storyboard` 节点类型与 `storyboard` 提示词模式)、以及 `src-tauri/skills/storyboard-prompt/`、`src-tauri/skills/multi-grid-storyboard-prompter/`、`src-tauri/skills/storyboard/` 三个技能包。**剧本创作与优化**（`screenplay` 节点与 `src-tauri/skills/screenplay/`）是另一个功能，保留。
- **创作助手**：画布右侧助手面板（`src/features/workspace/agent/` 整目录）、`canvas_agent` 提示词模式、`src-tauri/skills/canvas-agent/` 技能包与 `docs/integrations/canvas-agent.md`。
- **反馈与诊断**：反馈弹窗（`src/features/feedback/`）、后台自动错误上报、诊断资料收集与上传（`src/lib/errorReporting.ts`、`src/lib/diagnosticAttachments.ts`、`src/lib/collectFeedbackDiagnostics.ts`）、报错条里的「反馈问题」按钮。**「复制报错」必须保留**——AGENTS.md 的报错约定依赖它。
- **功能组件下载**：见「项目组件分发约定」。

# 测试约定

- **本项目不再保留任何测试资产，也不再执行测试**：没有 Vitest 用例、没有 `*.test.ts(x)` / `*.test.mjs`、没有 Rust `#[cfg(test)]` 模块、没有 `src-tauri/tests/` 目录。删测试时一并清掉测试依赖（`vitest`、`@testing-library/*`、`@vitest/browser-playwright`、`playwright`、`jsdom`、jest 相关插件等）、`vitest.config.ts`、eslint 的测试插件与 CI 里的测试步骤。
- **本项目允许使用编译器做验证**（用户 2026-10-28 明确要求）：`npx tsc --noEmit`（前端类型检查）与 `cargo check`（Rust 类型检查）**可以运行，且应当运行**——改共享类型、跨模块重构、大范围改动时没有编译器兜底风险太高。本条只放开「编译器」这一类验证，**不**重新启用测试套件、eslint / knip / prettier / clippy / 前端构建 / Tauri 打包 / `pnpm codegen`。
- **除编译器外，仍不运行测试、lint 与打包类门禁**（用户 2026-10-27 明确要求）：包括前端构建、Tauri 打包、`cargo build`、vitest、`pnpm lint` / eslint、`pnpm knip`、`cargo clippy`、`cargo fmt --check`、`prettier --check` 和 `pnpm check`。不要为了门禁新增测试；保留仓库里已有的构建与 CI 配置，除非用户另外要求修改。通过阅读代码、已有产物和不涉及编译的实际交互检查核对实现，交付时如实说明验证范围和未验证部分；只有用户明确改变要求后才运行上述命令。
- **别指望门禁兜底**：测试与 lint 这条免掉的不只是时间，还有发现手段。async 函数被当 void 回调传、`useMemo` 依赖数组漏项、React 回调不稳定导致 effect 反复重跑这类问题，只能靠读代码时逐处核对；写回调、传 props、列依赖、传回调给 hook 这四类地方要主动多看一眼。
- **`src/lib/bindings/*.ts` 仍是 ts-rs 生成物**：保留生成机制，但默认不运行 `pnpm codegen`，因为它会触发 Rust 编译；需要更新绑定时须先取得用户明确的新要求。
- **Rust 的 MSRV 声明要跟实际用到的语法与依赖对齐**：`Cargo.toml` 的 `rust-version` 是 **1.89** —— 本仓库代码在用 let-chains（2024 版稳定于 1.88），依赖里 `notify-rust 4.18`（经 `tauri-plugin-notification`）要求 1.89。写低了会让用那个版本机器的人在依赖解析阶段撞上 "requires rustc 1.89.0 or newer" 这种难以定位的报错。

# 生成请求约定

- 生成接口的能力、素材数量/格式/大小/时长、参数范围、枚举、账户权限及参数组合由服务端兜底；不要在 React 前端或 Tauri 本地后端按缓存目录、旧文档或本地白名单拦截用户请求。
- 客户端负责按当前 API 文档完整编码用户参数与素材；文档新增字段时补齐上传和映射，不能以“未定义/不支持”为由拦截，也不能静默丢弃输入。界面枚举仅提供选项与默认值，保留用户显式参数。
- 保留本地文件读取、素材/任务身份、凭据冻结和请求编码完整性保障；服务端拒绝时呈现其真实错误。付费提交回执不明确时核对原任务，不删字段重发或自动重复扣费。
- **批量／可重试的付费提交必须带固定任务身份**（`StartGenerationCommand.clientTaskId`）：身份由前端在提交**之前**就写进画布文档，后端按「同一身份 + 同一份请求」只创建一次任务（`tasks.rs` 的 `existing_client_task` 比对 `logical_request.clientRequestHash`，不同则返回 `Conflict`）。这样重复点击、恢复、重提都只会拿回同一个任务，不会产生第二笔付费请求——前端因此可以放心做「继续或核对」：先查任务在不在，在就只认领，不在才用同一身份重提。请求内容变了（镜头或生成节点被编辑过）就不能复用身份，这时把该条标成「需处理」而不是重发。
- **轮询与刷新只能走状态轻量接口**（`get_generation_task_progress`）：`get_generation_task` 是**诊断详情**，它会带回每次供应商调用的完整请求体与原始响应体——一次图片调用就是几 MB 整包 base64，一个视频任务有几十次调用，`resolved_request` 里同样可能埋着整包素材。生成期间每 1.5~6 秒拉一轮详情，等于让几十 MB 报文反复穿过 IPC 边界；生成相关的 Tauri 命令又跑在 UI 线程上，界面会整片卡住、生成键也解不开（新任务发不出去）。后端已把详情里的报文**在 SQL 层截断**（请求 8KB、响应 32KB，并回带原始字节数），详情接口只应在用户真的要看某次调用的报文时按需调用。状态接口带 `logicalRequest` 与结果 `source`，轮询路径靠它就够还原记录卡。**一次性回填**（如画布启动时恢复产物卡、用户点「从任务历史恢复」）确实需要完整产物字段时可以用详情接口，但**不得放进定时器**，也不得按任务数量成批拉。
- **前端 TS 开了 `exactOptionalPropertyTypes`**：可选属性不能显式传 `undefined`，类型要写成 `prop?: T | undefined` 才接得住；`phase` 这类字面量联合字段要显式 `as const` 或 `as 字段类型`，否则会被推成 `string`。
- **创作台的「文本生成」不经过统一媒体任务管线**：统一管线显式拒绝 `GenerationOperation::TextGeneration`（"text generation is not a canvas generation task"）——文本模型是同步返回、没有远程任务号，请求构造也在文本通道（`prompt_optimize.rs`）而不在 provider 层，形状与媒体任务不同。创作台文本生成走专用命令 `start_text_generation`：同步建任务 → `tauri::async_runtime::spawn` 后台执行 → **立刻返回任务 ID**，前端按 `get_generation_task_progress` 轮询，正文从 `generation_task_events` 的 `text_output` 事件取。**提交后必须立刻返回**：一次文本模型调用动辄十几秒，若照媒体任务那样「等结果出来才解锁」，创作台就发不出第二条，生成键会被按住几十秒——与「生成时锁按钮」是同一个坑。创作台的参考素材走 `reference_inputs`（target 支持 `asset` / `local_base64_asset` / `local_file`），不要用 `multimodal_inputs`（要 mimeType，创作台没有）。交付内容是**模型原样回答**（`general_text` 分支），不做提示词抽取。

# 入口与生成页约定

- 同一个前端产物只有两个入口，由 `src/features/create/createEntry.ts` 统一判定：`studio`（默认，画布工作台）与 `create`（创作台）。判定通道：URL `?view=` > hash > Tauri 窗口标签。新增入口时在这一个文件里加，不要在 `App.tsx` 里散落判断。
- **创作台窗口不能在 Tauri 命令里同步建**（`src-tauri/src/lib.rs` 的 `open_create_window`）：同步命令跑在 UI 线程、且在 WebView2 的 IPC 回调栈里，在那里再建一个 WebView2 控制器会踩 WebView2 的重入限制——控制器的创建完成回调要等当前回调返回才派发，而 wry 正阻塞在等它（`wait_with_pump` → `GetMessageA`）。结果是窗口外壳建出来、webview 永远停在 `about:blank`（**白屏**），整个 UI 线程被卡死（主窗口看着还活着，实际不再响应任何 Tauri 事件）。正确做法：命令体用 `async`（跑在异步运行时上），建窗口的动作交给 `AppHandle::run_on_main_thread` 排到事件循环的下一轮——那里已不在 WebView2 回调栈里，同时窗口仍建在事件循环线程上（tao 要求如此）。新增任何「命令里开窗口」的功能都照这个形状写。
- **`async` 是这条约定的前提，不是风格**：`run_on_main_thread` 在**事件循环线程上会就地执行**（tauri-runtime-wry 的 `send_user_message` 判断 `current_thread().id() == main_thread_id` 就直接处理消息），所以同步命令调 `run_on_main_thread` 等于没绕开——照样在 WebView2 回调栈里建窗口，照样死锁，而且**没有任何编译错误**，症状与原来的 bug 一模一样。凡是「命令里要开窗口」的命令，一律写成 `async fn`。
- **命令的结果要回传前端，并且带超时**：别手写这套流程——用 `src-tauri/src/lib.rs` 的 `run_window_action`（延后到事件循环 + oneshot 回传 + 10s 超时 + 前端已放弃就不再执行窗口操作 + 闭包 panic 被关在里头，五件事都在里面）。手写就一定会有人漏掉超时、漏掉「前端收到『超时，请重试』之后窗口又凭空冒出来」那个守卫（`sender.is_closed()`），或者漏掉 panic 守卫——建窗口的闭包跑在事件循环线程上，它 panic 会穿出线程边界、release 下直接 abort 整个进程（与 `backend/protocol_reply.rs` 的 `run_catching_panic` 同一个道理）。
- **创作台的「画布」入口是跨窗口动作**：侧栏「画布 → 全部 / 新建画布」不要在创作台窗口里导航画布入口——入口在挂载时按 URL / 窗口标签定死（`createEntry.ts`），创作台窗口的标签永远是 `create`，导航只会把创作台自己重载一遍。跨窗口交给后端命令 `focus_main_window`（`src-tauri/src/lib.rs`）：它把画布工作台窗口拉到前台，主窗口不在时重建一个（重建同样要 `async` + 排到事件循环，见上面两条）。
- **画布工作台的「先存后关」是单点依赖，必须留兜底**（前端 `src/features/workspace/CanvasWorkspace.tsx` 的 `onCloseRequested`，后端 `src-tauri/src/lib.rs` 的 `arm_close_watchdog`）：Tauri 只要发现窗口注册过 close-requested 的 JS 监听器，就**无条件** `prevent_close()`（tauri 的 `manager::window::on_window_event`），原生 WM_CLOSE 被吞掉——窗口能不能关掉全看 JS 有没有跑到 `destroy()`。而记录 JS 监听器的那张表（`js_event_listeners`）**只在 JS 主动 unlisten 时才清理**：渲染进程一崩，监听器注册永久残留，Rust 于是永远 prevent_close、JS 却已经没人跑，窗口就再也关不掉（只能任务管理器）。所以三条不能破：① Rust 侧保留关闭兜底看门狗（超时强制销毁窗口），前端明确「保存失败、窗口保持打开」时调 `cancel_forced_window_close` 把它撤掉，否则兜底会与「窗口保持打开」的提示自相矛盾；② 前端关闭流程里不能有「既不关窗口、又不复位 `closing` 闩锁」的出口——闩锁卡死时用户再点 ❌ 会被静默吞掉，表现同样是「关不掉」；③ 保存要有上限（`withCloseFlushTimeout`），并且把「保存卡住」与「保存失败」分开处理：卡住（应用已不可用）强制关窗，失败（存档没写进去但画布还在内存里）留窗口让用户重试。
- **「窗口关不掉」有两种模式，兜底方式完全不同**（都表现为「点右上角 ❌ 没反应，只能任务管理器」）：
  - **渲染进程死亡**：上面那条（JS 监听器注册残留 → Rust 永远 prevent_close → 没人调 `destroy()`）。现场签名：宿主进程还活着、`Responding=True`、但**一个 `msedgewebview2.exe` 子进程都没有**，日志尾部连续出现 `[tauri_runtime_wry] WebView2 error: HRESULT(0x8007139F)`。兜底＝Rust 侧关闭看门狗（超时后 `Window::destroy()`，实测渲染进程被杀后 **8.07s** 关掉）。
  - **事件循环代理失效**：tao 的 `EventLoopProxy::send_event` 就是 `PostMessageW` 到一个隐藏窗口「Tao Thread Event Target」。这个窗口没建成（tao 此时返回**空句柄**、代理永远发不出消息）或已被销毁时，Tauri 的 `destroy()` / `close()` **全部**失败，报错文案是 `runtime error: failed to send message to the webview`——这句文案有误导性，它说的不是「webview 发消息失败」，而是「事件循环代理不可用」。现场签名：日志出现上面那句报错，且枚举顶层窗口找不到「Tao Thread Event Target」。此时连 Rust 侧的看门狗也发不出去，唯一出路是**摘掉 JS 的关闭监听器**：没有监听器 → Tauri 不再拦截 → 原生关闭请求直接生效（用户要再点一次 ❌，前端会提示「关闭失败，画布已保存，请再点一次关闭按钮」）。
- **测关闭窗口不要用 `Get-Process` 的 `MainWindowHandle`**：多线程下它会随机返回不同的句柄（实测同一进程两次拿到两个值，其中一个根本不是主窗口），必须自己 `EnumWindows` 按窗口类（`Tauri Window`）+ 标题（`无限画布`）挑，否则 WM_CLOSE 会打空、测出「关不掉」的假结论。
- **别用 CDP 改 `window.__TAURI_INTERNALS__.invoke` 来模拟失败**：它是 `writable:false, configurable:false`，赋值被静默忽略，桩根本没生效——测出来的现象会被误当成真实行为（曾据此误判「关闭监听器没注册」）。要模拟「destroy 发不出去」，正确做法是把 tao 的代理窗口打掉（给「Tao Thread Event Target」发 WM_CLOSE），这样复现的是真实故障路径。
- **画布文档的存取命令必须是 `async`**（`save_canvas_document` / `get_canvas_document` / `list_canvas_documents` / `delete_canvas_document`）：同步命令跑在 UI 线程、且在 WebView2 的 IPC 回调栈里，存档写入是本地 SQLite 事务，落在 UI 线程上就等于把整个应用按住——窗口不响应、事件循环停摆，连「点 ❌ 关闭」这条兜底路径都发不出去（`destroy` 同样要排队等事件循环）。命令体写成 `async fn` 才会被 Tauri 挪到异步运行时上，UI 线程全程不被占。
- 创作台在 `src/features/create/`：侧栏 / 顶栏 / 记录流 / 底部浮坞 / 资产库抽屉五件套。视觉规格全部来自对即梦创作页的实测，数值落在 `tokens.css` 的 `--color-create-*` / `--size-create-*` / `--create-text-*` 令牌组里；改样式时只改令牌，不写字面值。
- **资产库不是外部服务**：它接本项目自己的素材库（本机 Base64 + 已接入供应商的云端），实现在 `src/features/create/useCreateAssets.ts`。不要为了「看起来更像」去接别人的资产接口。
- 参考素材必须带**素材身份**而不是 URL：`CreateReference` 有 `local_file` / `asset` / `local_base64_asset` 三种形状，映射到后端三种合法 target（`src/features/create/useCreateSession.ts`）。`mediaType` 取素材真实类型，role 由媒体类型分派（`reference_image` / `reference_video` / `reference_audio`，与后端 `media.rs` 的归一表一致）。把 video 素材按 image 送，后端会按图片通道读视频字节——失败或静默忽略。
- 资产库抽屉是**页面网格里的第三列**，不是 `position: fixed` 浮层。做成浮层会把底部浮坞的提交钮压在抽屉底下，用户表现为「面板开着就发不了」。
- **素材拖拽一律用指针事件，不要用 HTML5 `draggable` / `dataTransfer`**：Tauri WebView 的系统拖放处理器会截走 dataTransfer 拖拽（画布素材卡早就因此改成指针拖拽，见 `workspaceModel.ts` 里「素材卡片使用指针拖拽」那条注释）。创作台这边同理：拖拽源在 `CreateAssetDrawer`，落点在浮坞（`CreateComposer` / `CreateAgentComposer`），会话与命中测试收在 `src/features/create/createAssetDrag.ts`。三条容易踩的细节：① 落点靠 `data-create-drop-zone` 属性标记 + `elementFromPoint` 命中测试找（不用 dragover/drop），浮坞外壳挂属性、拖拽源 `closest()` 向上找；② 拖拽结束后浏览器会补发一次 click（落在 mousedown 与 mouseup 的共同祖先上），必须吞掉，否则「拖进浮坞」会把素材同时点选进挑选列表；③ 缩略图要写 `draggable={false}`，否则浏览器原生拖走图片会在半路接管这次手势。
- **隐形浮层不许压住可交互控件**（`opacity: 0` 的按钮照样吃点击）：工具条两侧那两块滚动浮层（即梦 `.scroll-button-container`）曾挂在 `.create-toolbar` 上，`right: 0` 落到工具条右缘——正好是动作区的提交键，那枚隐形按钮把提交键整个盖住（实测两者矩形只差 3px），点击全被它吃掉；而它只做 `scrollBy`，参数没溢出时什么也不发生，用户看到的就是「点发送没反应」，后端连一条日志都没有。两条规矩：① 浮层的定位基准是**参数区**（`.create-toolbar__params`），不是整条工具条；② 隐形按钮默认 `pointer-events: none`，只有那一侧真的能滚时才接管点击（否则「创作类型」下拉最左侧 49px 也是死区）。排查这类「点了没反应」用 UI 自动化把窗口内控件矩形列出来做相交检测（PowerShell + `System.Windows.Automation`），比读 CSS 快也准。
- **顶栏挂在整页上，不在内容列里**（即梦实测 `top-actions-host` 是整页级绝对定位）：抽屉开合时主区会变窄，但顶栏不跟着移。放在内容列里的话，抽屉一开顶栏就左移 94px，看着像被挤走了。顶栏移到 `.create-surface` 顶层，抽屉打开时右缘让开抽屉宽度即可。
- 逆向结论与逐项实测数值见 `docs/integrations/jimeng-generate-page-re.md`（页面外壳）与 `docs/integrations/jimeng-model-switching-re.md`（模型与参数）。

# Agent 模式约定

即梦的 `?type=agentic` 是**同一个创作页的另一套浮坞**，不是第三个入口。创作台仍是两个入口之一（`studio` / `create`），进入方式是 `?view=create&type=agentic`。

- **URL 只承载 `agentic`**：`?type=` 存在即 Agent 浮坞，离开时删掉这个参数。其余四种生成类型（图片/视频/文本/音频）仍走服务端偏好 `creationMode`，不让 URL 和服务端偏好抢同一个状态。
- **两套创作类型互不干扰**：`standardMode` 是标准浮坞的模式（落服务端偏好），`creationMode` 是 Agent 浮坞那份 7 项清单的当前项（即梦的 option value：`agentic / image / video / music / audio / digitalHuman / actionCopy`）。即梦两个浮坞的下拉本来就是两份清单，不要合成一份。
- **七项创作类型全部要列出来**：音乐生成 / 数字人 / 动作模仿本项目后端没有对应能力，但前端照做，并在下拉里标「后端暂未接入」——不许藏起来，也不许让用户点了才发现报错。
- **Agent 模式允许空提示词**（实测校验项 `allowEmpty`）：选了技能或主体就算有效输入。提示词上限 20000 字（实测 `get_agent_config.promptMaxLength`）。
- **三块浮层各有各的形态**：技能下拉是「搜索 + 官方角标 + 一行简介 + 更多技能」；「自动」展开的是**生成偏好面板**（自动开关 / 图片视频 / 比例 / 模型），不是模型下拉；「@」是主体选择器（空态要有「创建主体」出口）。别拿普通 `CreateSelect` 套这三块。
- **普通浮坞与 Agent 浮坞是两套控件序列**：普通浮坞（`?type=image`）实测是 `创作类型 → 模型 → 比例+分辨率 → 生成数量 → 文字效果增强 → @主体 → 生成`；比例与分辨率**合并**成一个按钮（中间用 3×3 圆点 `.divider-OobeV4` 分隔），但**生成数量独立成按钮**（「2张」，浮层 320×97 / 圆角 16 / 8 个 34×36 数字磁贴 / 无标题）。「技能」「语音」是 Agent 浮坞独有，普通浮坞没有。参数与数量按钮都是**前置图标 + 文字、没有下拉箭头**。
- **参考上传砖是斜的**：48×64、逆时针 8°（实测 matrix `0.990268, -0.139173`）、虚线描边、悬停 `translateY(-8px) scale(1.125)`。
- **字体用即梦的栈**：`--font-jimeng`（正文：`"CapCut Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial`）与 `--font-jimeng-montserrat`（工具条按钮与下拉数字：Montserrat 打头）。**不要用 `--font-body` / `--font-display`**——那是画布工作台的字体，用了会一眼看出不是原站。
- **图标用即梦原生路径**：`src/features/create/jimengIcons.ts`（从原站活体 DOM 抽的原文 path）+ `JimengIcon.tsx` 渲染。**不要再用 `src/components/Icon.tsx` 的 Phosphor**——那是通用图标库，形状与原站不同。覆盖侧栏、顶栏、浮坞、工具条、创作类型 7 枚、**记录卡 hover 层（下载/查看更多/收藏 + 播放条 3 枚 + 底部 9 枚编辑工具）与两处菜单的图标**。即梦的「查看更多」是**横向**三点，别再用竖排的 `dots-three-vertical`。
- **记录卡的 hover 层与菜单按即梦实测来**（2026-10-22 活体，见 `docs/integrations/jimeng-generate-page-re.md` 第七节）：
  - 工具组是**每格一份**（hover 哪格就在哪格上），两组共用一块面板底（`rgba(24,25,29,.9)` + 0.5px 描边 + 圆角 8 + 内边距 2 + 间隙 2），按钮 28×28、图标 16×16。
  - 右上工具组 3 枚：下载 / 查看更多 / 收藏。**图片格与视频格的底组条目不通用**：图片 7 枚（用作参考图/智能超清/超清/智能改图/局部重绘/扩图/查看更多），视频 9 枚（局部重拍/用作参考视频/智能超清/视频延长/视频编辑/补帧/对口型/全能配音/擦除字幕）。
  - **一共有三处「更多」菜单，别混**：操作行末位 = 记录菜单（删除/反馈生成问题）；格子右上 ⋯ = 产物菜单（图片：复制/用作参考图/创建主体/──/发布/删除/举报；视频少「复制」）；图片格右下末位 ⋯ = 工具菜单（生成视频/去画布编辑/消除笔/多角度(New)/细节修复/对口型）。
  - 资产库素材卡的更多菜单是**七项**（下载/收藏/用作参考视频/创建主体/发布/删除/举报），即梦用**右键**触发，本项目照做并另加一枚 hover 显形的「⋯」。
  - 视频格左下**没有**时长角标（那是资产页那一套），时长显示在播放条里，格式是两位分钟 `00:05`。
  - 视频格**hover 即自动播放、移开暂停并复位到 0**（即梦实测 `paused` 由 true 变 false）；先试有声，被浏览器策略拒绝再退回静音。
  - 时间分隔符是 **0.5px × 10px 竖线 rotate(15deg)**（渲染出来是斜杠），别画成纯竖线。
  - **长提示词的抬头是 hover 展开的浮层**：默认只显示 2 行（48px），悬停展开成最多 10 行（240px）的可滚动面板，底色 `#262626`、圆角 8px、投影 `0 4px 12px #0000000f, 0 2px 6px #00000005`、`z-index: 10`；右下角绝对定位一枚「⧉ 使用提示词」文字按钮（`right:4px; bottom:4px`，文字 `#ffffff99`、14px/24px，图标 16×16），点它把提示词填进浮坞输入框。
  - **浮坞的蓝色 ✦ 与消耗位**：即梦给「新模型 / 新能力」在参数摘要末尾挂一枚 12×12 蓝色 ✦（`#2b6cf6`），标记由能力目录的 `ModelParameterOption.aiMark` 驱动（只对语义明确是 AI 能力的选项打标，如「智能比例」）；提交键左边是消耗位（16×16 蓝色四角星 + 12px/12px Montserrat 500 的文字、`rgba(255,255,255,.6)`），即梦那是它 SaaS 的积分单价，本项目没有成本预估接口，保留位置与外观、内容如实写「待接入」，不编造假单价。
  - **点开产物进的是「产物详情整页视图」**（`CreateDetailView.tsx`），不是弹个遮罩：左边大图 + 底部 `‹ n / N ›` 翻页 + 左上返回箭头；右侧栏 **440 宽**、`padding: 8px 40px 20px`：顶部行（下载 / ☆ / ⋯）、缩略图条（86×86、间隙 4）、`图片提示词`（14px/22、`#ffffff99`）、参数标签行、**两块工具卡片**（底色 `rgba(255,255,255,.08)`、圆角 12px、内边距 4px；卡内 168×36 两列网格、间隙 4px，按钮圆角 8px、内边距 `0 14px`、图标 16px、文字 13px/24，末行占满两列）、底部卡片「重新编辑 / 再次生成」。
  - **视频产物走的是另一套详情布局**：标题「视频提示词」；没有缩略图条；翻页是大图区**右侧竖排**两枚箭头；「详细信息 ⓘ」另起一行；工具卡 1 = 用作参考视频 | 去画布编辑 ›，卡 2 = 8 枚视频工具（局部重拍/智能超清✦/视频延长/视频编辑/补帧✦/对口型/全能配音/擦除字幕✦New）；播放器是自绘控件条（播放/暂停 + `00:00 / 00:00` + 静音 + 全屏 + 2px 进度线，贴住**视频**底边）。`✦` 是即梦给 AI 能力打的蓝色标记（`toolAiMark`）。
- **搜索点别处就收回**（即梦实测）：展开后点页面其它地方，容器立刻从 254 宽回到 28 宽。用 `pointerdown` 外部判定，不要用 `blur`（点放大镜时会先收起再展开，闪一下）。
- **下拉浮层按作者值写**：即梦机器 DPR=1.5，实测到的 `0.67px` 描边其实是 `1px` 被设备像素对齐后的回读值。照抄实测数字会在别的 DPR 上错一档。
- **后端暂未接入的能力**（Agent 对话流 `/mweb/v1/creation_agent/v2/conversation`、技能市场、主体体系、语音输入）走 `TODO(agent-*)` 标注 + 前端占位：结构定死、交互做全、点击给出明确说明，不静默失败。载荷契约见 `createAgentModel.ts` 的 `AgentSubmissionPayload`。
- 逆向结论与逐项实测数值见 `docs/integrations/jimeng-agentic-page-re.md`。

# 浮层锚定约定

- **浮层必须贴在触发器上**：面板**底边**贴触发器**顶边**，留 8px 缝（实测即梦 7.7px）。这是即梦 `lv-trigger-position-bl` 的语义，所有浮层（下拉、参数面板、生成偏好、技能、主体）一律照做。
- **浮层左边缘比触发器左边缘左移 16px**，不是对齐。源码级证据：即梦 `js/async/420.ce00760bd1.js` 模块 `342266` 的 `popupAlign: { top: [-16, 8], bottom: [-16, 8] }`（常量 `ED = -16`）；四处浮层（创作类型下拉 / 技能下拉 / 主体选择器 / 生成偏好面板）活体实测也全部是 −16、缝隙 7.67px。创作台用 `useCreateFloatingLayerAnchor`（默认 `leftOffset = -16`）；**朝下弹**的浮层（如顶栏筛选）不左移，给 `leftOffset: 0` + `gap: 12`。
- **定位必须用浮层的「实测高度」，不能用高度上限**。CSS 的 `top` 锚定的是**顶边**，拿 `max-height` 当高度算，面板会多上浮「上限 − 实际高度」px，与触发器之间裂开一条黑缝——参数面板上限 420、实际 120 时会飘到触发器上方 300px，孤零零挂在视口中间。正确做法是用 `ResizeObserver` 量浮层自己的高度，量到后再定位。
- 统一走 `src/components/floatingLayer.ts`（坐标计算，`leftOffset` / `gap` 可配）+ `src/features/create/useFloatingLayerAnchor.ts`（测量与贴靠，五个浮层共用）。**不要各写一份**——旧版本就是五处各写各的，其中一处把上限当高度，浮层直接飘了。
- 浮层一律 portal 到 `document.body` + `position: fixed`：创作台的参数工具条是 `overflow-x: auto` 的横向滚动容器，浮层留在工具条 DOM 里会被祖先裁掉，用户看到的是「点了没反应」。
- 顶栏搜索按即梦的逻辑做：**input 常驻**（收起时宽 4px 被容器裁掉，只露放大镜），靠容器 `data-open` 切状态，**不是**「按钮 ↔ 输入框」整体替换。展开的触发是**点放大镜**（hover 不展开）。展开时整组向左生长，组右端与组内右侧按钮位置都不变。
- 网格里的卡片若要显示长文本：`<button>` 的 UA 样式表带 `align-items: flex-start`，交叉轴不 stretch，文本宽度会退化成 max-content 画到邻列上。必须显式写 `align-items: stretch`，网格轨道写 `minmax(0, 1fr)`（不是 `1fr`），文本本身补 `min-width: 0` 才能让省略号生效。

# Escape 仲裁约定

- **Escape 只有一个决策点**：`src/components/escapeArbiter.ts` 是全应用**唯一**的 Escape 仲裁器（全仓只挂一个 window 级 keydown 监听，**冒泡阶段**）。浮层 / 弹窗 / 面板要响应 Escape，一律用 `useEscapeHandler({ canHandle, handle }, active)` 注册，**不要**再写 `window.addEventListener("keydown", …)`：平行监听器彼此看不见，「一次按键关两层」「按 Esc 没反应」就是这么来的（修复前全仓有二十多处各自处理 Escape，捕获阶段的那些会在 React 冒泡处理**之前**抢走按键，`useModalFocusTrap` 还 `stopImmediatePropagation()` 把同层别的监听一起掐掉）。
- **捕获阶段抢不到、也抢不得**：捕获阶段还没有人处理过 Escape，`defaultPrevented` 恒为 false，捕获阶段监听必然抢在内层之前动手。冒泡阶段排在元素级 React 处理器之后，内层浮层（`CanvasSelect` / `CreateSelect` / `SearchableMultiSelect`）可以先用 `preventDefault()` 认领这个键。
- **一次按键只有一个处理者**：仲裁器按「优先级大 → 后注册（更内层）」找第一个 `canHandle()` 为真的处理者，执行它就收工，其余不再动作。层级关系要写进 `canHandle`（浮层家族用 `hasOpenChildLayer`，「事件落在打开的下拉里」用 `isInsideOpenPopup`），不要再靠「谁先注册」赌。
- **优先级**：浮层 / 弹窗默认 0；说明气泡 `ESCAPE_PRIORITY_TOOLTIP`（-100）；画布背景动作（Esc 退出：清选中 / 退出连线手势）`ESCAPE_PRIORITY_CANVAS`（-500）。气泡排在画布背景动作**之前**，是为了让「Escape 关闭当前显示着的那一条说明」「延迟中、还没显示的那条也要被压住」这两条既有约定真的生效；画布背景动作排在浮层**之后**，是为了浮层开着时 Esc 只关浮层。
- **画布的 Esc 快捷键也走仲裁器**：原来 `useHotkeys("esc", …)` 在 document 冒泡阶段 `preventDefault()`，会把画布上所有浮层 / 抽屉的 Esc 全部吃掉（它们原本挂在捕获阶段才抢得过它）——画布上「抽屉 / 缩放菜单 / 摄像机面板按 Esc 关不掉」的根因就在这里。现在它是仲裁器里的一个处理者（画布背景动作），输入框 / 文本域里不触发（沿用 `react-hotkeys-hook` 默认的 `enableOnFormTags: false` 口径）。
- **注册表挂在 `globalThis` 上**：模块被重新求值（HMR、依赖被打两份）会得到**新的**处理者数组与**新的** window 监听器，而旧监听器里残留的旧处理者会**先**抢到 Escape——它调用的是已卸载组件的 `setState`（等于什么都没做），却已经把按键吃掉并 `preventDefault()`，表现是「按 Esc 没反应」且没有任何异常。注册表挂全局对象、监听器只挂一次并转调 `registry.dispatch`（始终是最新一版实现）；`useEscapeHandler` 另外记「已卸载」，卸载后的处理者不再动手。
- **已认领就不动作**：`defaultPrevented` 为真直接返回（已被元素级 React 处理器认领的键不再二次处理）；输入法组合期间（`isComposing` / `keyCode === 229`）一律不处理。

# 报错提示约定

- 用户看到的报错必须用人话：一律用 `src/components/ErrorAlert.tsx`（红色高亮 + 图标 + 文字）渲染，显示 `backendErrorMessage(error)` 的摘要；原始 payload / 堆栈只放进「展开完整报错」。
- 不要再用 `<p role="alert">{error}</p>` 或 `formatRawBackendError(error)` 直接给用户看：那会把 `{"details":null,"kind":"validation",…}` 这种 JSON 印在界面上，读屏软件还会整段朗读。
- `formatRawBackendError` 只用于日志与调试输出，不是用户文案。
- 报错不能只靠颜色区分（WCAG 1.4.1）：必须同时有图标和文字；触发错误的控件用 `aria-describedby` 指向错误元素（WCAG 3.3.1）。
- 报错要能回答「接下来怎么办」：`ErrorAlert` 的 `hint` 写补救动作；只说「这张图不合格」不说换什么图，用户只能靠猜。
- 任何报错都必须支持一键复制：`ErrorAlert` 自带「复制报错」按钮（复制摘要 + 完整原始 payload）；手写报错条旁边放 `src/components/ErrorCopyButton.tsx`，错误 toast 一律从 `src/lib/toast.ts` 导入 `toast`（`error` 自动带「复制报错」动作）。复制的内容必须是完整诊断文本，不要只复制界面上被截断的摘要。
- 报错不再自动上报：反馈与诊断子系统已下线（见「已下线功能约定」）。需要留下现场时只写本地日志（`frontendLog`）与剪贴板，不要新增任何静默上传路径。

# 画布外壳对齐约定（liblib.tv）

- 画布工作台的**视觉层与前端逻辑层**以 `docs/integrations/liblib-canvas-re.md` 为真值源：那份文档里的每个数值都来自 liblib.tv 画布页的**活体实测计算样式**（登录态、DPR=1.5），不是观感推测。改动画布外壳前先读它。
- 画布外壳用**独立的一组令牌**（`--canvas-*` / `--panel-background` / `--nt-*` / `--topnav-btn-border` / `--radius-ll-float` / `--shadow-ll-float` …），**不要**混进全局 `--color-surface-*` 阶梯：原站画布底色是 `#141414`（比本项目原来的纯黑亮）、节点卡 `#191e26`（带蓝相），混用会让画布层次塌掉。
- 左下控件组是**一条连续胶囊**，组内**只有原站那六项**：资产管理 / 整理画布 / 切换小地图 / 隐藏节点连线 / 网格吸附 / 缩放。组内按钮 28px 高、8px 圆角、4px 间隙，各自**没有**边框与投影（表面由外层组提供）；hover 底 `--canvas-controls-hover`，按下 `--canvas-controls-active`。别把它做成一排各自带面板底的小盒子，也**不要**再加回原站没有的按钮组。
- 底部浮坞居中，**只有原站那八格**：`⊕ 创建节点` / 移动·框选 / 功能组件 / 表情 / 时钟 / 键盘 / ? / 品牌胶囊。功能组件与表情在原站是应用入口，本项目对应能力已下线，**保留位置并标注「后端暂未接入」**，不留点了没反应的空按钮。
- **画布外壳的图标用 Lucide，不用 Phosphor**：原站用 Iconify，除品牌图标（`iconify--libtv`）外都是 `iconify--lucide`，与 Lucide 是同一套矢量。全站其它地方仍用 Phosphor，只有画布外壳走 `src/features/workspace/CanvasChromeIcons.tsx`。原站自有的品牌图标无法逐字复刻，用语义最近的 Lucide 代替。
- 画布外壳的实测尺寸（别凭观感估）：底坞 padding 8 / gap 8 / 按钮 32×32 / **图标 20px** / 圆角 12 / 底色 `#262626`；左下控件组 gap 4 / 内边距 6 / 按钮 28×28 / **图标 14px** / 文字 13px。
- **原站没有的视觉/样式/前端逻辑，一律不做**：要加一个入口前先查本文档的 UI 面清单；原站没有的按钮组（例如节点操作组、归位、撤销重做、素材库浮坞格）不要留在画布外壳上，它们的能力走**键盘快捷键**与**右键菜单**。
- 顶栏按钮按原站是 32×32、8px 圆角、**0.5px** 描边（原站声明 `border-[0.5px]`，DPR=1.5 下回读成 0.667px——按 0.5px 写，见「浮层锚定约定」同类结论），底色 `color-mix(in srgb, var(--panel-background) 80%, transparent)`。
- 顶栏的画布切换按原站是「画布 N ⌄」chip + 下拉（`CanvasTabs` 的 `canvas-tabs__switcher`）：重命名与删除收在菜单里，标签上不再挂行内按钮。
- 浮层圆角是 **12px**（`--radius-ll-float`），投影是三层（`--shadow-ll-float`），描边 `--canvas-controls-border`。不要用全局的 16px `--radius-panel`。
- 原站的**资产管理**是左侧全高抽屉 + 右侧 12px 可拖动调宽把手（`workspace-panel-drawer-resize-handle`），内容是「画布列表 → 资产」两级树。抽屉必须 portal 到 `document.body`：画布视口带 transform，会劫持 `position: fixed`。
- 节点卡、连线与手柄按原站实测值写死在 `CanvasNodeCard.css` / `CanvasNodeCardIcons.tsx`：连线 2px `#86909c`（悬停 `#c0c8d0`、选中 `#e0e4e8`，所有连线同色）、手柄本体 0×0 + 80px 命中区 + 20px 旋钮（默认隐藏，悬停/选中才出现）、媒体区 12px 圆角 + hairline 描边 + 底色 `#171717`（选中描边 `#a8a8a8`）、节点根**没有**边框圆角内边距。节点卡的图标走 `CanvasNodeCardIcons.tsx`（Lucide 直导）。
- **原站没有的节点卡与连线元素一律删除**：连线上的顺序徽标、删除按钮、卡片上的删除/改名按钮都不存在——连线删除走「点中连线后按 `Delete`」，节点删除走「选中后按 `Delete`」，画布改名走「点标题就地编辑」。
- 新手引导按原站是**首次进入画布**时弹的一次性 4 步浮层（`CanvasOnboardingGuide`），文案抄原站 i18n（`onboardingStep1~4Title/Desc` + `guideDefaultSkipLabel/PreviousLabel/NextLabel/DoneLabel`）；看过一次记进 `localStorage`（`canvas-onboarding-seen-v1`），不要再改文案或改成常驻入口。浮坞的「教程」格可以再次打开它。
- **空画布状态**按原站是「一行提示 + 一排创建入口」，不是说明卡片：指针图标 + 「双击画布 自由生成节点」，下面一行五个入口（图片生成 / 视频生成 / 音频生成 / 剧本生成 / 智能剪辑，每个约 208×44），点一下直接建对应节点（`EMPTY_CANVAS_SHORTCUTS`）。
- 底部浮坞居中，**只有原站那八格 + 一枚品牌球**：`⊕ 添加节点` / `移动` / `功能组件` / `表情` / `全部功能` / `生成历史` / `快捷键` / `教程`，右侧是 **48×48** 的品牌球（深色圆底 + hairline 描边，内嵌渐变球，**在浮坞容器外面**）；「快捷键」与「教程」之间有一根 **1×24** 的竖分隔线。功能组件、表情、全部功能本项目没有对应能力，**保留位置与图标并标注「后端暂未接入」**。原站浮坞中间几格随项目内容变化（有素材库/角色造型室能力的项目会替换「功能组件/表情」），本项目按默认工作区那一组实现，顺序与图标是活体 DOM 实测的，别凭印象改。
- 左下控件组是**一条半透明胶囊**：背景 `rgb(26 26 26 / 70%)`、圆角 12、内边距 6、间隙 4，**没有描边也没有投影**（所以它几乎融进画布）；组内六项（资产管理 / 整理画布 / 切换小地图 / 隐藏节点连线 / 网格吸附 / 缩放档位）各自透明、28px 高、图标 14px，整理画布是**图标按钮**（不是文字），缩放档位只有百分比没有下拉箭头。
- 分组（组框）按原站是**半透明彩色大框 + 左上角同色小标签**，框上没有工具条：框 = 该色 14% 填充 + 45° 斜纹（1px 线 / 7px 间距）+ 同色边框；标签 = 同色实底、白字 11px、圆角 4、高 20px，压在框的上边线上，同时是整组的拖动手柄。组动作（复制整组 / 折叠 / 添加到素材库 / 解散）走**右键菜单**，改名是**双击标签就地编辑**。配色登记在 `tokens.css` 的 `--canvas-group-ink-1..6`（按组 id 稳定取色）。
- 原站的技术栈是 Tailwind v4 + Mantine 7 + Ant Design + React Flow 混合体。**我们不引入这些依赖**，只对齐它们的结果：类名等价物写进我们的 CSS，数值写进 `tokens.css`。
- 逆向产物在 `.tmp/rea-liblib/`（gitignored）：`i18n.json` 8655 条文案、`tailwind-classes.json` 1898 个类、`design-tokens.json` 1124 个令牌、`measurements.json` 实测计算样式、`survey/` 交互截图。改画布外壳前可以先查这些原始证据。

# 画布编辑层对齐约定（liblib.tv）

- 生成节点的编辑层（`MediaNodeViews.tsx` 的 `CanvasGenNode` + `CanvasGenEditor.css`）结构按原站 liblib 的**实测**结构定死，顺序不能改：
  **工具 chips 行（参考 / 标记 / 角色库 / 运镜）→ 已连接素材缩略图瓦片 → 提示词正文 → 底栏**。
  原站没有可见的「提示词」标题行，那段文字只作读屏标签（`aria-labelledby` / `aria-describedby`），不要改回可见标题。
- 原站的编辑层**宽 658.67px**（本项目写 660），面板根是 `flex flex-col gap-2 p-2`（间隙 8、内边距 8）；不要为了「看起来更宽」擅自拉宽——原站那 1145px 是被 chips 与缩略图撑出来的。
- 底栏只有四段：**模型按钮 · 全能参考按钮 · 1px 分隔线（#525252，高 14）· 参数汇总按钮**；右侧是 32×32 白底、圆角 12 的提交键（**不带文字标签**）。原站没有「更多设置」这个底栏按钮——本项目的更多设置收在参数浮层底部的「高级设置」折叠区（hairline 上边框 + 12px 粗体标题）。
- 参考素材是 **48×48 方形瓦片**（1px hairline #525252、圆角 8、object-cover 裁切），左上角 14×14 序号角标、右下角 12×12 的 **@ 圆钮**（把这份参考插进提示词）、hover 时右上角出现 15×15 解除连线按钮；原站用拖拽排序、没有上移/下移按钮，所以编辑层里那两个按钮是隐藏的，键盘排序由瓦片自身（可聚焦，↑/↓）承担。瓦片上**不放**素材名、不放来源角标——原站没有，来源信息收进瓦片 title。
- 提示词正文：14px、行高 1.8、最小高 80px、滚动区上限 100px、右内边距 6px；面板圆角 12。**提示词区里不放任何按钮**（原站没有）：@ 在参考瓦片上，识别素材名仍留在提示词节点里。
- 设置浮层（模型 / 参数）宽 **365px**，**底边贴触发器顶边上方 8px**，挂在**编辑层 DOM 内**（编辑层是定位祖先，按相对坐标贴靠，画布平移缩放不用重新测量）。浮层内容不是编辑层 DOM 的后代会让既有断言查不到它，别改成挂到 `document.body`。
- **生成结果图上不压「AI生成」水印**：原站 liblib 在媒体左上角有一枚位图水印 `watermark.png`（48×23），本项目曾用文字胶囊替代，**现已按用户要求整体删除**（图片节点与视频节点共用 `VideoGenerationNode.tsx` 里的同一处实现，一起去掉，对应 CSS 类 `canvas-node-preview__badge` 已删除）。不要按「与 liblib 完全一致」把它加回来。

# 智能剪辑（video clip）约定

- 「智能剪辑」是**独立节点类型** `video_clip`（原站 liblib 的 `video-clip`）。它取代了本项目原有的本地「视频拼接与合成」节点（`video_composer`，已整体下线）。逆向规格见 `docs/integrations/liblib-video-clip-re.md`，数值全部来自 2026-10-23 的活体实测。
- 节点卡两态照抄原站：**空态 350×350**（40px 剪刀 + 「空空如也，请连接视频节点后操作」+「尝试：」四个预设：讲解视频 / 批量广告 / 口播视频 / 素材混剪）；**连接态 566×350**（252px 封面 + 82px 时间刻度 + 「打开智能剪辑」）。提示文案与预设顺序一字不改。
- 合成编辑层（`VideoClipEditor.tsx`）结构照抄原站，顺序不能改：
  **「＋参考」chip + 素材瓦片（48×48，左上角序号、左下角时长）→ 提示词正文（占位「描述想剪成什么效果」）→ 底栏（剪辑模式按钮 · 参数汇总按钮 · 32×32 提交键）**。
  原站智能剪辑的编辑层**没有模型按钮、没有「更多设置」**，工具行**只有「＋参考」**（生成节点那四枚 chips 不照搬过来）。
- 剪辑模式目录在 `videoClipModes.ts`：五个模式（默认模式 / 讲解视频 / 批量广告 / 口播视频 / 素材混剪），每个模式声明自己的**素材槽位**（节点类型 / 必填 / 最少 / 最多）、预置提示词与技能标识。槽位归属按模式声明顺序分槽，一份素材只进一个槽位。
- 槽位校验文案用原站原文：`还需添加{label}（至少 {min} 个）` / `{label}最多 {max} 个` / `请填写提示词`；label 取 视频 / 音频 / 文字 / 产品图 / 参考视频 / 生成视频。
- 参数是**模式表之外**的一份全局配置：比例 21:9 / 16:9 / 9:16 / 1:1 / 4:3 / 3:4、时长 0~300 秒、清晰度 480P / 720P / 1080P，默认 16:9 · 720P · 30s，摘要文案 `16:9 · 720P · 30s`。
- 两个浮层（剪辑模式 229.3×170.1、参数 341.3×310）与生成节点的设置浮层**做法不同**：原站这两个是 Mantine Popover，挂在 `document.body` 上、与触发器左边缘齐平（不左移），底边分别距触发器顶边 4px / 0px。本项目用 `placeFloatingLayer` + `ResizeObserver` 实测高度贴靠，**高度必须用实测值**，不能拿上限当高度。
- 提示词**不进画布 store**：住在提示词模块（`promptContents`）里，与生成节点一致。保存画布时它的 key 必须进 `collectCanvasDocument` 的快照集合，否则重开画布提示词会丢。
- 原站的预置素材是它自家 CDN 的资源地址，本项目**不拉外链**：预设只落「模式 + 提示词」，素材由用户自己连进来。**这些外链 URL 也不要留在源码里**——既误导（本项目不引入外链素材），又留着将来误接的风险；预设表里只保留提示词文案。
- 成片名带序号（`智能剪辑成片 {index}`，与节点名「智能剪辑 N」呼应）：产物名同时用于输出节点显示名与任务历史，固定文案会让多个智能剪辑的成片同名，画布上无法分辨。产物名只作本地命名元数据，**不参与结果文件命名**，所以不会互相覆盖。
- 后端契约：`video_clip.rs` 的 `start_video_clip` 负责讲解 / 广告 / 口播的供应商视频生成适配，必须携带稳定 `clientTaskId`。默认模式 / 素材混剪走 `video_clip_render.rs`：冻结文本模型与凭据引用，读取原视频并抽取中点帧，生成受校验的剪辑方案，再用内置 FFmpeg 实际裁切、拼接与导出；读任务记录不重新提交。模式不暴露模型按钮，使用工作区默认文本或视频模型。
- 「打开智能剪辑」已接本项目的 `VideoClipTimeline`：裁切 / 分割 / 排序 / 音量 / 淡入淡出 / 字幕轨，支持 MP4、SRT 和本项目 JSON 工程的导出与导入。剪辑决策持久化在节点 config，预览租约不得落盘；复制节点清空原任务身份与投递记录。它不是原站私有时间轴或 PR / 剪映工程格式的还原，不宣称支持这些私有格式。智能编排只看中点抽帧，不能声称看完整视频、识别真实语音或完成音频节拍分析。
- 原站的预置素材是它自家 CDN 的资源地址，本项目**不拉外链**：预设只落「模式 + 提示词」，素材由用户自己连进来。
- 「智能剪辑」在画布创建菜单里指向 `video_clip`。旧的 `video_composer`（本地「视频拼接与合成」）节点类型**已整体下线**：模型、store 类型面、视图、样式、客户端、合成任务后端（`start_video_composition` 等命令）与 WebView MediaRecorder 实时合成模块全部删除；旧画布里的这类节点按已下线类型的先例**直接丢弃，不做兼容读取**。原站画布节点清单里没有「视频拼接与合成」这一项。
- **新增画布节点类型时，`WorkspaceApp.tsx` 的 `CANVAS_NODE_TYPE_KEYS` 必须同步加进去**。这个清单决定「画布成员 key 集合」，选中集、@ 引用候选、节点查找都从它派生；漏登记的症状是节点能建出来、能渲染，但**永远选不中**（点它没反应、编辑层不打开）。目前登记：`asset / gen / screenplay / videoClip / result / output`。

- 智能剪辑的「＋参考」复用 `CanvasReferenceTools`（本地上传 / 画布挑选，含文字与剧本节点），不依赖原站后端。剪辑在途时，预设、模式、参数与解除连线必须锁定；状态读失败只能重新读取，不能代替用户重发付费请求。

# 音频节点约定

- 画布的「音频」节点（`gen.kind === "audio"`）逆向自 liblib.tv 画布的音频节点，规格见 `docs/integrations/liblib-audio-node-re.md`，数值全部来自 2026-10-28 的**活体实测**（登录态、DPR 1.5）。它是**生成节点的一种**（`gen`），不新增 store 节点类型：沿用 `genNodes` 持久化、`NodeModelSelections`、提示词模块与 `CanvasNodeEditorShell` 外壳。
- 节点卡是 **320×350**、圆角 24、底色 `--nt-bg-float`；空态中央是 48×48 音符图标 + 「尝试：」+ 一枚「音频生视频」预设按钮。标题条图标（波形）与卡片音符、预设按钮的方框播放图标**照抄原站 SVG path**（`CanvasAudioNode.tsx` 里的 `AudioWaveIcon` / `AudioNoteIcon` / `AudioToVideoIcon`）——Lucide 里没有同构字形，语义相近但形状差很多的替代品反而更糟。
- 生成编辑层（`CanvasAudioNode.tsx` + `CanvasAudioNode.css`）自上而下：**工具 chips（上传 / 画布参考）→ 提示词正文 → 底栏**。底栏从左到右是 **模型下拉 · 格式下拉（语种 / 采样率 / 输出格式三段）· 翻译 · 高级设置 · 字数 `0/2000` · 消耗位 · 32×32 提交键**，一字不差的顺序不要改。
- **模型下拉列本项目供应商目录里 `speech_generation` 能力的模型**，不照抄原站那 6 个 SaaS 模型名（Seed Audio 1.0 / Eleven V3 / Mureka V8…）。模型下拉用 `CanvasSelect`（画布节点里的下拉一律用它，不用原生 `<select>`）；格式下拉是**三段式浮层**（原站就是一个触发器弹三个分区），用 `placeFloatingLayer` + portal 挂在 body 上，高度必须用实测值。
- **消耗位显示「—」**：原站那里是积分单价，本项目按供应商实际计费、没有积分余额——编一个单价出来就是骗人。
- 参数映射（前端 → 后端 `parameters`）：`language` / `sample_rate`（8000·16000·24000·48000）/ `format`（wav·mp3·pcm·ogg_opus）/ `voice_setting_speed`（0.5–2 步长 0.01）/ `voice_setting_pitch`（-12–12 步长 1）/ `voice_setting_vol`（0.01–10 步长 0.01）。这六个键**不能过 `generationParameters` 的能力白名单**（白名单只留模型 Schema 声明过的键，会把它们全筛掉），后端按名字显式取。网关 TTS 契约里没有语言项，`language` 会被忽略。
- `pcm` 在本项目**不可用**（无头裸流没有容器信息就没有时长，既校验不了也不能安全配进音轨，后端直接拒收）。条目**保留**（与原站逐项对齐）但在格式浮层里**置灰并写明原因**——悄悄删掉会让「与原站一致」说不清，留一个必然失败的选项而不说明则是陷阱。见 `AUDIO_NODE_FORMAT_DISABLED`。
- **音频参考素材的语义是「音色参考」**：至多 1 段音频，作为 `audio_data` 随请求发送；图片 / 视频参考被拒。前端先拦一道并说人话（「音频节点只接受音频素材作为音色参考」），后端 `media.rs` 的 speech 分支再兜一道。
- 「音频生视频」只**建节点 + 连线**（视频节点摆在音频节点**右边**，边是「音频 → 视频」），**不自动发起付费生成**——用户还没写提示词也没确认模型，自动提交等于替用户按下付费按钮。
- 提示词正文住在**提示词模块**（`promptContents`）里，不进画布 store；因此音频节点的 key 必须进 `collectCanvasDocument` 的快照集合（现有实现按「画布里现存的节点 key」求交集，新增挂 `PromptMentionInput` 的节点类型自动覆盖）。
- 后端走**既有生成任务管线**（`operation: "speech_generation"` + `clientTaskId` 幂等），不新开 Tauri 命令：`provider.rs` 的 `GenerationSubmission::Audio` → `tasks.rs` 落 `pending_audio_result` → `local_results.rs` 的 `save_audio` 写盘 → 产物 `mediaType` 为 `audio`。**只支持网关 TTS 线路**（`seed-audio*`，`POST /v1/tts/create`）；豆包 SSE 线路（`seed-tts*`）会给出明确报错，不静默失败。
- 产物落卡后，音频节点卡里用原生 `<audio controls>` 播放（项目里没有音频波形组件）。

# 画布快捷键约定

- **快捷键面板（`CanvasShortcutsDialog`）列出的每一条都必须真的绑上**。面板文案照抄原站 i18n，但原站有、本项目没有对应能力的条目（画布连线、复制整组、搜索节点、整理画布、抓手/移动工具、导演台整组）必须标 `available: false`，渲染成置灰 + 「待接入」角标。**不能让用户照着面板按却毫无反应**——那比不列出来更糟。
- 缩放键位是 `mod+=` / `mod+-` / `mod+0`（原站注册表口径），`0` 走 `fitView`（适应画布），不是"重置到 50%"。不要绑裸键 `+` / `=` / `-` / `0`——那会让随手敲一个等号就缩放。
- **`react-hotkeys-hook@5.3.3` 默认按 `event.code`（物理键位）匹配**，除非显式传 `useKey: true` 改用 `event.key`（字符值）。`"="` 的 code 是 `Equal`、`"-"` 的是 `Minus`——按 code 匹配时 `mod+=` / `mod+-` **永远匹配不上，缩放快捷键会完全失效且毫无报错**。凡是用字符键（`=`、`-`、`.`、`,` 等非字母数字键）的热键，都必须带 `useKey: true`。
- 成组 `mod+g`、解组 `mod+shift+g`、撤销 `mod+z`、重做 `mod+shift+z`、复制 `mod+c`、粘贴 `mod+v`、复制节点 `mod+d`、删除 `Delete`/`Backspace`、退出 `Esc` 已实装。新增快捷键时同步更新面板的 `keys` 与 `available`。

