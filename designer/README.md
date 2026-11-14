# Designer (prototype)

一个**纯前端原型**：把用户意图编译成 **DSL**（契约 = 仓库根 `schema/dsl_schema.json`），由 Python 管线 `oview.pipeline` 再转成 Odoo view。**Designer 只产出 DSL，不产出 QWeb**——这正是「designer → DSL → Odoo view」流水线效率的来源（见仓库顶部 README 的对比）。

## 运行

直接用浏览器打开 `index.html` 即可（无需构建、无需服务器）。

> 联网时从 CDN 加载 `js-yaml`（YAML 导出）与 **Ajv 8 的 Draft 2020-12 浏览器构建** `dist/2020.bundle.js`（权威 schema 校验）。本仓库契约是 Draft 2020-12：原先引用的 `ajv.min.js` 是 CommonJS 单文件构建，浏览器会抛 `exports is not defined`，且只支持 draft-07，无法编译本契约。离线 / CDN 不可达时退化为 JSON 导出 + lean 校验，仍可工作；右栏「选择文件」加载 `schema/dsl_schema.json` 才启用权威校验。

## 界面：三栏画布

设计器是**画布式**（所见即所得），而不是表单填写：

- **左栏 = 工具箱**：Module；Models 卡片（加载/上传模型定义）；图层面板；字段面板（可拖拽的字段 chip）；添加元素按钮（分组 / 布局块 div / 笔记本 / 按钮 / 分隔线 / 标签 + **已注册的自定义元素**）+ 结构条按钮（顶部条 header / 底部条 footer）；**「自定义注册」卡片（view type / view element / action 三类声明）**；结构树（含注册表摘要）。
- **中栏 = 画布**：实时渲染当前表单——分组以卡片呈现、笔记本以标签页呈现、字段以「标签 + 控件」行呈现（控件样式随字段类型变化：布尔→勾选、选择→下拉、many2one→搜索框、one2many→列表块……）；自定义 view type 显示类型横幅 + 元素投影，自定义元素以 `⟨Tag⟩ props` 块呈现。可拖拽字段落到容器、点选元素、▲▼ 移动；顶栏可「+ 视图绑定」按标准或已注册类型新建 binding。
- **右栏 = 检查器 + DSL 输出**：选中元素的属性（显示控制）在上方；DSL（YAML）+ 结构校验状态 + 近似 arch 预览在下方；「下载 .yaml / 复制」导出。

### 画布仿真细节（贴近真实 Odoo）

中栏不是「示意框」，而是尽量复用真实 Odoo 前端的 DOM 结构与社区版浅色主题（见 `odoo.css`，类名沿用 `.o_form_view` / `.o_form_statusbar` / `.o_group` / `.o_field_widget` / `.o_notebook` 等）：

- **状态栏（statusbar）**：表单顶部渲染 `.o_form_statusbar`——左侧放操作按钮，右侧放状态 pills（来自主模型的状态选择字段，如 `sale.order.state` 的 5 个状态），首个状态默认高亮（chevron 形），与 Odoo 行为一致。有了显式 `<header>` 时按钮与状态字段取自 `header.children`；没有时兼容旧 DSL，仍把根层 `button` 自动上提。
- **分组（group）**：`.o_group.o_inner_group` 网格，按 `col` 列排布，`colspan` 横向占列；字段行 = `.o_form_label` + `.o_field_widget` + 类型角标，并标注 `o_readonly_modifier` / `o_invisible_modifier`。
- **笔记本（notebook）**：`.o_notebook` 标签页（`.o_notebook_headers` / `.o_notebook_tab` / 页容器），点标签即选中该页并进入检查器。DSL 中笔记本以 `pages: [{ string, children }]` 表达，与 `schema/dsl_schema.json` 及生成器 `oview` 完全对齐。
- **布局块（div）**：`.o_layout_div` 虚线容器，顶部标注 `<div class="…">`（用户写的 Odoo class 只作文字标注，不应用到画布 DOM，避免破坏仿真布局）；`children` 递归渲染，可拖入字段或选中后点选字段，支持 `colspan` 跨列。
- **独立标签（label）**：`.o_dsl_label` 显示 `string`，并用小角标显示 `for` 指向的字段名与 `class`；`for` 只用于显示关联，**不作为 xpath 定位键**（定位铁律仍只允许 `@name`）。
- **字段控件按类型仿真**：布尔→勾选框、文本→多行框、选择→下拉（选项取自 `selection`）、`radio` widget→单选组、many2one→带搜索图标的输入、many2many→标签（tag）列表、one2many→内嵌列表块、日期→日期选择、binary/图像→上传/预览；只读字段渲染为 `.o_readonly_value`。
- **列表视图 / 搜索视图**：切换 `viewType` 为 `list` / `search` 时，画布分别渲染 `.o_list_view` 表格（含示例数据行）与 `.o_search_panel` / 搜索 chip（来自 `filter` 元素）。

### 顶部条 / 底部条（header / footer）

`header` / `footer` 是 Odoo `form` arch 的**一等结构条**（规范 §2 / §6.5），不是设计器页面自己的页头页脚：

- `header`（限 `form` / `list`）：在画布顶部渲染为状态栏区域，放操作按钮与 `widget="statusbar"` 的状态字段；DSL 为 `{ kind: header, children: [...] }`，`class` / `groups` / `invisible` 会透传到 arch。
- `footer`（仅 `form`）：在画布底部渲染为右对齐的按钮区，常用于对话框的「保存 / 取消」。
- **位置固定**：`header` 必须是视图根 `elements` 的**第 1 项**，`footer` 必须是**最后一项**，各最多一个，且不能嵌套进 group/notebook。这是 Odoo RNG 对 `<form>` 子节点顺序的要求；设计器因此禁用结构条的 ▲▼ 调序，从字段面板 / 拖拽 / 「+ 元素」往根层添加的内容会**自动插到 footer 之前**，普通元素也不能 ▼ 越过 footer 或 ▲ 越过 header。lean 校验与后端 `ELEMENT_STRUCTURE` 会同时拦截违规。
- **编辑方式**：左栏「+ 顶部条 header / + 底部条 footer」一键添加（自动放首/末、去重、按 viewType 过滤）；画布点选结构条后，字段面板 / 拖拽 / 「+ 字段」都落入其 `children`；切片层不能新增结构条（会弹原生对话框提示改用 `patches` 的 xpath），但画布仍显示基础层的结构条镜像。
- 默认示例的 `base` 层已带一个 `header`（确认订单 / 发送报价 / state 状态条）和一个 `footer`（保存 / 取消），打开即可见；导出的 DSL 与 `oview.pipeline` 产物中的 `<header>` / `<footer>` 一一对应，反向转换也保留结构（不再被穿透吞掉）。

### 布局块与独立标签（div / label）

`div` 与 `label` 是 Odoo arch 的共享元素，现已是一等 DSL 元素（规范 §2）：

- **div**：`{ kind: div, children: [...] }` 通用布局容器；`class` / `groups` / `invisible` / `colspan` / `name` 等属性逐键透传，`children` 可任意嵌套（含其它 div、label、group、field）。生成器递归生成，反向转换**不再穿透**（旧版把 `<div>` 当布局容器吞掉结构与属性），`sheet` 仍是唯一穿透容器。
- **label**：`{ kind: label, for, string, class, colspan, nolabel, invisible, groups, help }`。检查器可编辑全部属性，`nolabel` 用三态下拉（未设置 / 1 / 0）写布尔值，不会产出 schema 不接受的 `"True"` 字符串。`for` 指向同表单字段名，仅用于显示关联。
- **添加方式**：左栏「+ 布局块 div」「+ 标签」；选中容器后从字段面板点选/拖拽即落入其 `children`；切片 patch 的 `elements` 里也能插入 div 作为注入容器。
- **往返无损**：`colspan` 反转为 integer、`nolabel` 反转为 boolean，生成器用 `1` / `0` 回写 arch；其余长尾属性走 `extra` 逐键透传。默认示例的 `base` 层含一个 `div.oe_title`（label + 带 `nolabel` 的单号字段）。
- **定位约束**：无 `name` 的 div / label 不自动生成 xpath，点选会提示改用内部带 `name` 的字段作锚点；带 `name` 的 div 可生成 `//div[@name="…"]`。

### 三类自定义注册（view type / view element / action）

规范 §2.1 的顶层注册表在左栏「**自定义注册**」卡片里编辑，**先声明后引用**，导出即 DSL 一等语义：

| 分类 | 编辑内容 | 引用方式 |
|---|---|---|
| **1 · view type** | `id`（类型键）、`name`、`className`、`tag`、`services`、`props` | 顶栏「+ 视图绑定」或右栏检查器的 `viewType` 下拉选择该类型；后端 B 按注册表生成 OWL 三件套 + `view_registry` + `ir.ui.view(type=id)` + client action |
| **2 · view element** | `id`（引用名）、`tag`（实际 arch 标签）、必需/可选 props 契约、`description` | 左栏「添加元素」出现 `+ <id>` 按钮 → 生成 `{ kind: customElement, ref, props }`；检查器按契约列出 props 输入，缺 required prop 会被 lean 校验拦下 |
| **3 · action** | `id`、`name`、`type`（url / server / **client**）、按类型显示 `url` / `model+code` / `tag+params+context` | 导出 `actions[]`；`type=client` 由后端 A 生成 `ir.actions.client` |

- **所见即所得**：选中自定义 view type 的 binding 时，画布顶部显示 `自定义 view type · <id> → <className>` 横幅，元素按投影渲染；自定义元素显示注册项的 `tag` 与 props 值，右栏可切换 `ref` 并按契约编辑 props。
- **与后端一致**：lean 校验覆盖 id 唯一/保留字、`viewType` 必须已注册、`customElement.ref` 必须命中、required prop、`client` 动作必须有 `tag`、自定义类型不支持 inherit 切片——与 `dsl_validate.check_registry_refs` 同结论，不出现「前端通过、后端报错」。
- **arch 预览**：自定义元素按注册表 `tag` 展开属性（props 逐键铺平），自定义 view type 的 arch 根标签即类型键；OWL 模板的权威产出仍归 `python3 -m oview.pipeline`。
- **边界**：设计器不生成 OWL JS 逻辑，也不把用户写的 Odoo `tag` 当成真实 DOM 标签名（一律用 `<div>` 投影，避免制造第二个 banner/contentinfo landmark）。

### 图层 / 切片（Layered inheritance）

一个 binding 的 `views[]` 是**有序继承层栈**（规范 §4.1，契约见 `schema/`）：

- **层 0 = 基础层（base）**：`mode: primary`，承载完整 `elements`。
- **层 k>0 = 切片层（slice）**：`mode: extension`，`inherit` 指向**前序层**（或含 `.` 的跨模块基视图 xml_id），通过 `patches`（xpath/position）做增量修改；**不带 `elements`**（生成器只消费 patches）。
- **有效视图（effective view）** = 基础层 arch ⊕ 所有后代切片。生成器不预合并，Odoo 运行时沿 inherit 链、按 `priority` 升序合并。

左栏「**图层 / Layers（继承栈）**」面板：

- 列出全部层，标注 `基础` / `切片` 徽标与 `层 k · p{priority}`；点行标题切换当前编辑的层。
- **＋ 切片**：生成唯一切片 id，默认 inherit 基础层；层栈自动规范化为 `priority = 16 + 层索引`。
- **▲▼ 调序**：层 0 恒为基础层（基础层不可下移、切片不可上移到层 0）；调序即重算 priority 与 inherit 前序约束。
- **删除**：基础层禁删；删除切片后自动修复其余切片的悬空 inherit。
- **inherit 输入框**：可填本 binding 前序层 id，或含 `.` 的跨模块基视图 xml_id（纯继承模块可无基础层）。

**切片编辑闭环**：

- 选中切片后，中栏画布渲染**基础层镜像 + 切片叠加预览**；顶栏可切换「沿链到当前切片」/「全部切片叠加（≈ 有效视图）」。
- 预览不只是徽标：`position=attributes` 的 `invisible`/`readonly`/`required`/`string` 会真实体现在控件上，插入元素显示占位块，未命中目标给出提示；当前切片与继承来的切片用不同颜色区分。
- **点选画布元素 → 一键生成修改目标**：右栏显示 `//field[@name="…"]` 与「＋ 以此元素为目标添加修改」；也可在 patch 上点「🎯 从画布选目标」后再点元素。
- **定位铁律：只有 `@name` 是唯一稳定键**。`string` 可翻译且可重复（两个 `<group>` 都叫「主要信息」完全合法），`for` 亦可重复，因此设计器**不会**为 group/page/notebook/separator/label 等无 `name` 的容器自动生成 xpath——点选它们会提示改用其内部带 `name` 的字段作锚点，或手写 `//field[@name="…"]/..`。手写 `@string`/`@for` 会被 lean 校验与后端 `PATCH_XPATH_UNSTABLE` 同时拦截。
- 右栏「切片修改 (patches)」编辑器：每条 patch 设目标 xpath 与 `position`；切换 position 会**自动迁移载荷**（`attributes`↔`attrs`，其余↔`elements`），保证产物始终符合契约。可添加字段 / 其它元素，点 chip 进入检查器编辑该插入元素，× 删除。
- 切片层里的基础层元素是**只读镜像**：检查器不会让用户在切片上下文误改基础层；要编辑插入的元素，请点 patch 里的 chip。从字段面板/拖拽加入的元素会落进 patch，不会写进 `extension.elements`。

> 默认示例已带切片 `slice_hide_amount`：隐藏「总计」、在「备注」后追加「客户单号」，打开即可见效果。

### 画布交互
- **加载模型**：左栏「加载示例模型」（内置 `res.partner` / `sale.order` / `sale.order.line`）或上传 JSON。
- **切换主模型**：画布顶栏的「模型」下拉，直接把**当前 binding 重新绑定**到另一个已加载的模型；字段面板随之切换为该模型的字段。多 binding 时每个 binding 的模型可独立设置。
- **加字段**：从字段面板**拖拽**到画布的某个容器（分组/页/根），或**点选** chip —— 若当前选中了一个容器则落入该容器，否则落入根。容器内也有「+ 字段」下拉兜底。
- **选元素**：在画布上点选任意字段/分组/按钮，右栏检查器显示其属性；选中容器后再点面板字段即落入该容器。
- **摆位置**：检查器里的 ▲▼ 调整顺序，或拖拽到不同容器。
- **布局 / 列跨度**：分组（group）可在检查器设 `col`（每行列数，默认 2），字段与分组可设 `colspan`（跨列数，默认 1）——画布网格实时反映：分组按 `col` 列排布，设了 `colspan` 的字段/分组横向占满对应列数。二者都会写进 DSL（`col`/`colspan`），后端管线原样落到 arch。
- **显示控制**：检查器里改 label、按类型选 widget、切换 隐藏/只读/必填、填 domain/context/groups。
- **加容器**：左栏「添加元素」按钮，落入当前选中容器或根。

### 其它语义组件
- **Bindings**：在画布顶栏切换要编辑的 `(model, viewType)` 与具体 view（primary / extension + inherit）。
- **Compositions**：`act_window` / `dashboard`，组合多个 view type（可 `ref` 引用自定义视图）——即「怎么被打开」。
- **Actions**：`url` / `server` / `client`（自定义 OWL 客户端动作：`tag` / `params` / `context`）打开方式，可在左栏注册卡片里增删改。
- **Menus**：`id` / `name` / `action` / `parent`——即「挂到哪」。
- **权威校验（可选）**：右栏「选择文件」加载实时 `schema/dsl_schema.json`，即用 Ajv 2020-12 按仓库契约做严格校验（需联网加载 CDN 的 `2020.bundle.js`；离线时自动退化到 lean 校验）。

## 转成 Odoo view

```bash
# 把下载的 yaml 放到项目里
python3 -m oview.pipeline your_file.yaml --out outputs
# 离线结构门禁（等同 Designer 里的 schema 校验）
python3 schema/validate.py your_file.yaml
```

产物在 `outputs/<module>/views/dsl_generated.xml` 与自定义视图的 OWL 三件套。

## 模型定义（字段来源）

设计器要先把**意图**编译成 DSL，而「字段摆哪、怎么显示」的前提是**先知道这个 model 有哪些字段**。因此设计器引入了**模型定义（model def）**作为 UI 上下文：

```
model def  ──知道字段与类型──▶  字段发现（从模型字段选，而非盲打）
                                   │
                                   ├─ 摆放：▲▼ 调整顺序、按 group/page 容器落位、字段面板快速加
                                   └─ 显示控制：label、按类型给 widget 建议、隐藏/只读/必填、domain/groups
```

> 模型定义**只活在设计器里**，不写进 DSL 产物——DSL 仍只引用字段名（`name`）。这保持了 DSL 的声明式与模型无关性。

### 加载方式
- **加载示例模型**：点左栏 Models 卡片的「加载示例模型」，内置 `res.partner` / `sale.order` / `sale.order.line`。
- **上传 JSON**：同一卡片选择文件，支持三种形态——单个定义 / 定义数组 / `{ "model.name": {...} }` 映射。
- 仓库已附带样例：`designer/models/res.partner.json`、`designer/models/sale.order.json`、`designer/models/sale.order.line.json`（可用 `python3 -m oview.pipeline` 之外的工具从 Odoo `fields_get()` 生成你自己的模型定义）。

### 模型定义格式
```json
{
  "name": "res.partner",
  "label": "联系人 / 客户",
  "fields": [
    { "name": "name",    "type": "char",      "string": "名称",   "required": true },
    { "name": "email",   "type": "char",      "string": "邮箱",   "widget": "email" },
    { "name": "company_id", "type": "many2one", "string": "公司", "relation": "res.company" }
  ]
}
```
字段属性说明：`name` 字段技术名；`type` Odoo 字段类型（决定 widget 候选）；`string` 默认显示标签；`required`/`readonly` 仅作提示；`relation` 关联模型；`widget` 可选默认控件。

### 加载后能做什么
- **字段发现**：字段面板列出该模型所有字段（chip 带类型角标）；画布上选中字段的 `name` 也变为带 datalist 的输入框，选中后自动补 `string` 标签与默认 `widget`。
- **摆放位置**：从字段面板**拖拽/点选**落到画布容器或根；检查器 ▲▼ 调顺序；校验递归检查嵌套子元素。
- **显示控制**：检查器里 `widget` 提供按字段类型过滤的下拉（如 `many2many` → `many2many_tags`/`kanban`）；`隐藏/只读/必填` 一键开关（写入 `invisible`/`readonly`/`required = "1"`）；`domain`/`context`/`groups` 仍可用。
- **交叉校验**：若 `field.name` 不在已加载模型里，或 `widget` 与字段类型不匹配，lean 校验会给出提示。

## 设计边界（刻意为之）

- **不内嵌 QWeb 生成器**。arch/OWL 的权威产出在 Python 端，避免 Designer 把 Odoo 机制重新烤进前端（那会退回朴素流水线）。
- 右侧「近似 arch 预览」只是布局示意，非权威结果；变更请以后端 `oview.pipeline` 产出为准。
- 校验分两层：浏览器内 lean 校验（即时反馈）+ 可选 Ajv 权威校验（加载实时 schema）；最终以 `schema/validate.py` 与管线为准。
- **lean 校验已与后端 `validator/dsl_validate.py` 对齐**：层 id 唯一、恰好一个基础层、inherit 目标存在/无环/指向前序、mode 与字段互斥、patch position/载荷互斥、切片内元素递归校验、xpath 定位键唯一性、**结构条的作用域/位置/唯一/嵌套检查**、**div.children 递归元素校验**、**三类注册表引用完整性（id 唯一/保留字、viewType 已注册、customElement.ref、required props、client tag）**——设计器显示的 ✓ 与后端结论一致，不再出现「前端通过、后端报错」。
- **前端实现按 Google Chrome `modern-web-guidance` 检索的现行最佳实践落地**：原生 `<dialog>`（不手写焦点陷阱 / Esc）、原生 `<button>` 做图层切换、`<label for>`/`id` 显式关联、DOM 整栏重建后恢复焦点、交互目标 ≥24×24 CSS px；不覆盖浏览器原生焦点指示器。注册卡片的动态增删列表**不挂 `aria-live`**（一次操作只应播报一次，不能让每个移动项都被朗读）；输入时用 `renderOutput()` 只刷新输出、不重建左栏，避免打字丢焦点；所有辅助按钮显式 `type="button"`。画布中的 Odoo DOM 仿真节点保留纯鼠标点选，不伪装成 `role="button"`，以免压平内部真实表单控件的语义。
- **画布里的 `<header>` / `<footer>` / DSL `<label>` 仿真节点一律用 `<div>` 承载**：它们是被编辑视图的可视化投影，不是设计器页面的文档区域；用真实 `<header>` / `<footer>` 会产生第二个 `banner` / `contentinfo` landmark（每页各只允许一个），而孤立的 `<label>` 没有关联控件会污染页面表单语义。设计器页面本身保持唯一的页面级 `<header>` / `<main>` / `<footer>`，结构条用可见文本标签标注，不给无 role 的 `<div>` 加 `aria-label`。
- **画布字段标签按指南显式关联**：`renderCanvas()` 末尾复用 `associateLabels()`，把 `.o_form_label` 与同一字段容器内的真实 input/select 用 `for` / `id` 关联，并给预览控件补 `aria-label`；仍无控件可关联的只读值 / 内嵌列表标签则降级为 `<div>`。因此画布内不留下孤立 `<label>` 或无名表单控件。
- **`div` / `label` 的 arch class 不应用到画布 DOM**：用户写的是 Odoo 类名，只作文字标注，避免用户内容改变设计器自身布局。

## 与仓库其它部分的关系

```
designer/  (本原型：意图 → DSL)
    │  产出 DSL (YAML/JSON)
    ▼
schema/    (dsl_schema.json/.yaml 契约 + validate.py 门禁)
    │
    ▼
oview/     (pipeline：DSL → Odoo view / OWL 组件)
```
