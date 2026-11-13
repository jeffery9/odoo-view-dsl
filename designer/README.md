# Designer (prototype)

一个**纯前端原型**：把用户意图编译成 **DSL**（契约 = 仓库根 `schema/dsl_schema.json`），由 Python 管线 `oview.pipeline` 再转成 Odoo view。**Designer 只产出 DSL，不产出 QWeb**——这正是「designer → DSL → Odoo view」流水线效率的来源（见仓库顶部 README 的对比）。

## 运行

直接用浏览器打开 `index.html` 即可（无需构建、无需服务器）。

> 联网时从 CDN 加载 `js-yaml`（YAML 导出）与 `ajv`（权威 schema 校验）。离线时退化为 JSON 导出 + lean 校验，仍可工作。

## 界面：三栏画布

设计器是**画布式**（所见即所得），而不是表单填写：

- **左栏 = 工具箱**：Module；Models 卡片（加载/上传模型定义）；字段面板（可拖拽的字段 chip）；添加容器按钮（分组/笔记本/按钮/分隔线/标签）；结构树。
- **中栏 = 画布**：实时渲染当前表单——分组以卡片呈现、笔记本以标签页呈现、字段以「标签 + 控件」行呈现（控件样式随字段类型变化：布尔→勾选、选择→下拉、many2one→搜索框、one2many→列表块……）。可拖拽字段落到容器、点选元素、▲▼ 移动。
- **右栏 = 检查器 + DSL 输出**：选中元素的属性（显示控制）在上方；DSL（YAML）+ 结构校验状态 + 近似 arch 预览在下方；「下载 .yaml / 复制」导出。

### 画布仿真细节（贴近真实 Odoo）

中栏不是「示意框」，而是尽量复用真实 Odoo 前端的 DOM 结构与社区版浅色主题（见 `odoo.css`，类名沿用 `.o_form_view` / `.o_form_statusbar` / `.o_group` / `.o_field_widget` / `.o_notebook` 等）：

- **状态栏（statusbar）**：表单顶部渲染 `.o_form_statusbar`——左侧放操作按钮（来自根 `button`），右侧放状态 pills（来自主模型的状态选择字段，如 `sale.order.state` 的 5 个状态），首个状态默认高亮（chevron 形），与 Odoo 行为一致。
- **分组（group）**：`.o_group.o_inner_group` 网格，按 `col` 列排布，`colspan` 横向占列；字段行 = `.o_form_label` + `.o_field_widget` + 类型角标，并标注 `o_readonly_modifier` / `o_invisible_modifier`。
- **笔记本（notebook）**：`.o_notebook` 标签页（`.o_notebook_headers` / `.o_notebook_tab` / 页容器），点标签即选中该页并进入检查器。DSL 中笔记本以 `pages: [{ string, children }]` 表达，与 `schema/dsl_schema.json` 及生成器 `oview` 完全对齐。
- **字段控件按类型仿真**：布尔→勾选框、文本→多行框、选择→下拉（选项取自 `selection`）、`radio` widget→单选组、many2one→带搜索图标的输入、many2many→标签（tag）列表、one2many→内嵌列表块、日期→日期选择、binary/图像→上传/预览；只读字段渲染为 `.o_readonly_value`。
- **列表视图 / 搜索视图**：切换 `viewType` 为 `list` / `search` 时，画布分别渲染 `.o_list_view` 表格（含示例数据行）与 `.o_search_panel` / 搜索 chip（来自 `filter` 元素）。

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
- **Actions**：`url` / `server` 打开方式。
- **Menus**：`id` / `name` / `action` / `parent`——即「挂到哪」。
- **权威校验（可选）**：右栏「选择文件」加载实时 `schema/dsl_schema.json`，即用 Ajv 按仓库契约做严格校验。

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
