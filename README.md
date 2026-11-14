# Odoo 统一视图 DSL · 中心仓库

> **本仓库（`odoo-view-dsl/`）是「Odoo 统一视图 DSL」项目的中心仓库（Central Repository / 唯一事实来源）。**
> 设计规范、生成器、静态校验器、参考样例**同仓共存**，不再分散于多个技能目录，从根上消除规范与实现对齐漂移。

把规范 **`docs/dsl_qweb_owl_specification.md`**（本仓库内）的「统一视图 DSL」(元素 → 视图 → 视图类型绑定 → 组合) 降低为可落地的 Odoo 产物。

> **一句话使命（双面定位）**：DSL 用来自**快速使用原生 view type 与原生 view element**，也用来**精确定义自定义 view type 与自定义 view element**。
> 边界：自定义元素"定义/接入"归 DSL、"实现（OWL JS 逻辑）"归 OWL；DSL 是 QWeb 的加速层而非替代。详见 `docs/dsl_qweb_owl_specification.md` §0.7。

## 中心仓库定位

本仓库收敛原本散落在 Odoo AI 软件工厂技能体系中的相关资产，作为统一视图 DSL 的**演进主场与权威载体**：

| 支柱 | 位置 | 职责 |
| :--- | :--- | :--- |
| **设计规范** | `docs/dsl_qweb_owl_specification.md` | 四层模型（Element → View → ViewTypeBinding → Composition）+ QWeb/OWL 定位 + 校验约束，唯一事实来源 |
| **生成器** | `oview/` | 两个编译后端：标准视图 → `ir.ui.view`；自定义视图 → OWL 三件套 |
| **反向转换** | `oview/to_dsl.py` | Odoo 视图 arch → DSL（把存量视图迁移进 `designer → dsl → odoo` 工作流） |
| **静态校验器** | `validator/` | `dsl_validate`（IR 快筛）+ `rng_validate`（RNG 终审） |
| **结构契约** | `schema/dsl_schema.yaml`（默认）`schema/dsl_schema.json`（等价） | JSON Schema (Draft 2020-12) 形式化四层模型；编辑器校验 + 离线结构门禁 |
| **参考样例** | `examples/` | 标准+组合、自定义 OWL 端到端样例 |

**与上游技能的关系**：`odoo-ux-expert`（QWeb/OWL 概念所有者）、`odoo-qweb-diagnostics`（校验引擎来源）、`odoo-kernel-expert`（模型/ORM 边界）是概念的*来源*；本仓库负责把这些概念**落地、实现并持续演进**，技能内的指针统一回指本仓库。

## 目标

DSL 单一事实来源 → 两个编译后端：

- **后端 A（标准视图）**：`ir.ui.view`(primary + extension) + `ir.actions.act_window`，输出 Odoo `data` XML。
- **后端 B（自定义视图）**：OWL 组件三件套 `.js` / `.xml`(QWeb) / `.scss` + `ir.actions.client` 注册。

> OWL 只是自定义视图的**构建框架**，不是 DSL；QWeb 是两种后端共用的模板子语言（规范 §0/§1）。

## 安装

```bash
pip install pyyaml lxml
```

## 用法

```bash
# 标准视图 + 组合（form/list/search + act_window）
python3 -m oview.pipeline examples/sale_order.yaml --out outputs

# 自定义视图（OWL 组件，旧兼容写法）
python3 -m oview.pipeline examples/custom_widget.yaml --out outputs

# 三类自定义注册表（自定义 view type / view element / client action）
python3 -m oview.pipeline examples/custom_registry.yaml --out outputs
```

> **DSL 主语言 = YAML**：示例与文档一律以 `.yaml` 书写（可读、可注释、可多行）。加载器同时接受 `.json`（兼容/程序生成），但**不推荐**作为手写格式。

生成后自动串联校验：`dsl_validate`(IR 快筛) → 生成 arch → `rng_validate`(RNG 终审)。

## 反向转换：Odoo 视图 → DSL（`oview/to_dsl.py`）

把**已有的 Odoo 视图**（ir.ui.view 的 arch XML，或单段 arch 片段）反转为 DSL，
用于把存量视图迁移进 `designer → dsl → odoo` 工作流（先在 designer 里可视化编辑，再生成）。

```bash
# 含 ir.ui.view record 的 data XML（单次或批量）→ DSL YAML
python3 -m oview.to_dsl views.xml --model sale.order --out sale_dsl.yaml

# 纯 arch 片段（根即 form/tree/search…）→ 需 --model 指明模型
python3 -m oview.to_dsl form_fragment.xml --model sale.order

# 想拿 JSON 而非 YAML
python3 -m oview.to_dsl views.xml --json

# 外部基视图切片（arch 根为 <data>）无法从内容推断视图类型时指定
python3 -m oview.to_dsl views.xml --model sale.order --view-type form

# 带自定义注册表还原：命中 viewElements[].tag 的标签 → customElement，注册表写回产物
python3 -m oview.to_dsl views.xml --registries examples/custom_registry.yaml --out sale_dsl.yaml
```

### 转换策略（与正向生成器对称）

- **结构化映射**：`field` `group` `div` `notebook`/`page` `button` `separator` `label` `filter` `header` `footer` 干净反转为对应 DSL Element；属性（`string`/`widget`/`invisible`/`readonly`/`required`/`domain`/`context`/`groups`/`col`/`colspan`/`nolabel`/`for`/`options`…）原样保留并按 schema 类型回转（`colspan`→integer、`nolabel`→boolean），`decoration-*` 等长尾进 `extra`。
- **`attrs` 单键提取**：`attrs="{'invisible': [...]}"` 提取为 `invisible` 字段；多键/未知键无法干净表达 → 整段 `raw` 逃逸（不丢信息）。
- **`raw` 逃逸舱**：不在 DSL 元素词汇的标签（如 `<newline>`、`<searchpanel>`）整段保留为 `raw`（必带 `reason`），保证产物通过 schema 校验且可回写为原文。
- **只有 `sheet` 穿透，其余结构标签全部结构化**：`sheet` 是无 DSL 对应概念的纯布局容器，展开其子元素避免整段 raw 吞掉内部结构；`header`/`footer`/`div`/`label` 是已实现的一等元素，反转为 `{kind, children?, ...attrs}`，属性与子节点无损保留（`label` 不再只留 `for`/`string`，`div` 不再被穿透吞掉）。
- **inherit → 切片（extension）**：同文件内继承（`<field name="inherit_id" ref="..."/>`）反转为 `mode: extension` + `inherit` + `patches`（xpath/position 还原）；**跨模块继承保留为含 `.` 的字面外部基视图引用**，仍是合法切片，不再降级成「缺 inherit」的非法 DSL。
- **`<attribute>` 结构化反转**：`<xpath position="attributes"><attribute name="invisible">1</attribute></xpath>` → `patch.attrs[]`；其余 position → `patch.elements[]`，与 `schema/$defs/Patch` 一一对应，round-trip 不丢信息。
- **层栈规范化**：同一 `(model, viewType)` 的多个视图按「primary 优先 + priority 升序」输出，保证层 0 恒为基础层。
- **多视图聚合**：同一 `(model, viewType)` 的多个 ir.ui.view 自动聚成一个 ViewTypeBinding。
- **自定义元素（可选 `--registries`）**：传入原始 spec / `collect_registry()` 输出时，命中 `viewElements[].tag` 的 arch 标签反转为 `{kind: customElement, ref, props}`，并把 `viewTypes[]` / `viewElements[]` 原样写回产物；未提供时按既有行为退化为 `raw`（注册表无法从 arch 推断）。

### 已知限制

- **`compositions` / `actions` / `menus` 不反向生成**：它们来自 Odoo 其它记录（`ir.actions.act_window` / `ir.ui.menu`），输出头部已注明「请手工补充」。
- **自定义视图的 OWL 模板内容不在 data XML**：模板在生成物的 `static/src/xml/*.xml`，反向转换只能恢复类型绑定骨架（空 `elements`），模板内容需人工补回；`--registries` 可保证注册表与 `customElement` 引用不丢。
- **外部基视图存在性需 Odoo 运行时核验**：跨模块 `inherit` 以字面 xml_id 保留；切片内容（xpath/position、attrs、elements）已完整反转。
- **存量 `@string` / `@for` 定位**：原文保留（不丢信息），但显式告警；本仓库只允许 `@name` 作为唯一稳定定位键（见下节）。
- 反向产物经正向 `pipeline` round-trip 已验证：`button.class`、`field.options`、attrs 提取等均能完整写回 arch（正向生成器已同步增强以支持这两项）。

## 目录结构

```
docs/
  dsl_qweb_owl_specification.md   # 统一视图 DSL 设计规范（四层模型 + QWeb/OWL + 校验），本仓库唯一事实来源
oview/
  model.py        # 加载 YAML/JSON → IR；binding 层 model/viewType 继承回退
  qweb_ir.py      # Element → QWeb IR 节点 → arch XML（含 raw 降级、extra、高级元素）
  backend_a.py    # 标准：View→ir.ui.view(primary/extension)；Composition→act_window
  backend_b.py    # 自定义：View→OWL 三件套 + 注册
  pipeline.py     # 校验→生成→落盘 主链路
  to_dsl.py       # 反向转换：Odoo 视图 arch → DSL（存量迁移）
validator/        # vendored：dsl_validate.py + rng_validate.py（来自 odoo-qweb-diagnostics）
schema/           # dsl_schema.yaml（默认）+ dsl_schema.json（等价）：JSON Schema 结构契约 + validate.py（自检脚本）
examples/         # sale_order.yaml（标准+组合）、custom_widget.yaml（OWL）、partner_combo.yaml（组合含自定义视图）、
                  # sale_order_layers.yaml（三层继承链 + 跨模块外部基视图切片）、
                  # custom_registry.yaml（三类自定义注册表端到端样例）
outputs/          # 生成产物（按 module 分包，已被 .gitignore 忽略）
tests/            # regression.py（B1/B2/G3）、test_to_dsl.py（反向转换）、test_layers.py（层栈/切片全链路）、
                  # test_custom_registry.py（三类自定义注册表全链路）
```

## DSL 规格格式（顶层，YAML 为主）

```yaml
module: dsl_demo
bindings:                       # 每个 (model, viewType) 下的一组 views，inherit 链接
  - model: x
    viewType: form
    views:
      - id: base
        mode: primary
        elements: [ ... ]
      - id: ext
        mode: extension
        inherit: base
        patches:
          - xpath: "//sheet"
            position: inside
            elements: [ ... ]
  - model: x
    viewType: custom
    custom: true
    views:
      - id: card
        className: Card
        services: [rpc]
        elements:
          - kind: field
            name: display_name
          # ...
compositions:                   # 多个 view type 组合成最终屏幕
  - kind: act_window
    model: x
    views:
      - viewType: list
      - viewType: form
    target: current
    searchViewRef: [2, "search_base"]
```

Element 种类：`field` `group` `div` `notebook` `page` `button` `separator` `label`
`header` `footer` `subview` `component` `customElement`（引用注册表）`filter`（search）`if` `foreach` `set` `slot` `dynamicAttr`
`call`（命名片段）`raw`（逃逸舱，必带 reason）。

> 完整可运行样例见 `examples/sale_order.yaml`（标准+组合）、`examples/custom_widget.yaml`（自定义 OWL）、
> `examples/partner_combo.yaml`（组合含自定义视图 + 菜单/动作）、`examples/custom_registry.yaml`（三类自定义注册表）。

## 三类自定义注册表（view type / view element / action）

此前自定义能力是硬编码的：只有 `viewType: custom` 一种、`kind: component` 一种引用、`actions[]` 只有 url/server。现按规范 §2.1 提供顶层注册表，**先声明后引用**：

```yaml
viewTypes:                       # ① 自定义 view type
  - id: partner_board            # 类型键 → ir.ui.view.type / view_mode / view_registry
    name: Partner Board
    className: PartnerBoard
    services: [rpc, notification]
    props: [partnerId]
    tag: my_module.partner_board
viewElements:                    # ② 自定义 view element
  - id: status_badge             # 引用名
    tag: StatusBadge             # 实际写入 arch / QWeb 的标签（缺省 = id）
    props:
      - { name: state, required: true }
      - { name: label, default: 状态 }
bindings:
  - model: res.partner
    viewType: partner_board       # ③ 具名引用注册表类型（不再是硬编码 custom）
    custom: true
    views:
      - id: board
        elements:
          - kind: customElement    # 引用 viewElements[].id
            ref: status_badge
            props: { state: state }
actions:                         # ④ 自定义客户端动作
  - id: open_board
    type: client
    tag: my_module.partner_board
    params: { defaultTab: all }
```

- **后端 B 以注册表为权威**：`className` / `template` / `tag` / `services` / `props` 来自 `viewTypes[]`；生成的 OWL 三件套在 JS 里 `registry.category("views").add(<id>, ...)`，并产出 `ir.ui.view(type=<id>)` + `ir.actions.client(tag=<tag>)`。具名类型可直接写进 Composition 的 `viewType` 进入 `act_window.view_mode`。
- **自定义元素按契约展开**：`customElement.ref` 未命中注册表、缺 `required` prop、传入未声明 prop，均由 `dsl_validate.check_registry_refs` 报 ERROR；生成器按 `tag` 输出节点并补 `default`，反向转换可用 `--registries` 无损还原。
- **自定义 action 显式化**：`type: client` 生成 `ir.actions.client`（`tag`/`params`/`context`/`target`），不再只能由后端 B 隐式生成。
- **兼容不变**：未注册的 `viewType: custom` + `custom: true` 仍合成隐式注册项（类型键取 view id），`custom_widget.yaml` / `partner_combo.yaml` 无需改写。
- **边界**：DSL 只负责「定义 + 接入」，OWL 组件的 JS 业务逻辑归 OWL；`props` 值按字符串写入标签属性（动态表达式请用 `component` / `dynamicAttr`）。自定义视图类型不支持 inherit 切片（后端 B 不预合并视图）。
- 设计器左栏「自定义注册」可直接编排三者，详见 `designer/README.md`；全链路回归见 `tests/test_custom_registry.py`。

## 怎么被打开 / 挂到哪（actions + menus）

DSL 把"视图如何被打开、挂载到导航何处"也作为**一等语义组件**，与 view type / view element 并列：

- **`compositions[]`** → 视图类 opener：`ir.actions.act_window` / `client`（主流"怎么被打开"）。
- **`actions[]`** → 非视图类 opener：`type: url`（`ir.actions.act_url`）/ `type: server`（`ir.actions.server`）/ `type: client`（自定义 `ir.actions.client`，见上节）。
- **`menus[]`**（新增）→ `ir.ui.menu`（"挂到哪"）：`action` 指向 composition id / explicit action id / 字面 xml_id；`parent` 指向 menu id / 字面 xml_id；**容器菜单（无 `action`）合法**，仅作分组父节点。
- **引用完整性**：`menu.action` / `menu.parent` 悬空（指向未知 id 且非字面 xml_id）会被 `dsl_validate` 报 `MENU_ACTION_DANGLING` / `MENU_PARENT_DANGLING` ERROR（不静默降级）。结构化校验（必填/类型）归 JSON Schema，引用完整性归 IR 校验器，两层各司其职。

```yaml
compositions:
  - kind: act_window
    id: partner_action          # 给 id，供 menus 引用其生成的 action
    model: res.partner
    name: Partners
    views: [{viewType: list}, {viewType: custom, ref: partner_card}]

actions:                        # 怎么被打开：补足 URL / 服务端动作
  - id: open_docs
    type: url
    name: 文档
    url: https://www.odoo.com/documentation
    target: new

menus:                          # 挂到哪：导航树
  - id: partner_root
    name: 合作伙伴
    sequence: 10
  - id: partner_menu
    name: 合作伙伴列表
    parent: partner_root        # 挂到上面那个菜单下
    action: partner_action      # 引用 Composition 生成的 act_window
    sequence: 10
  - id: partner_docs_menu
    name: 伙伴文档（外链）
    parent: partner_root
    action: open_docs           # 引用 explicit url action
    sequence: 20
```

## 结构契约（JSON Schema）

`schema/dsl_schema.yaml`（默认）/ `schema/dsl_schema.json` 把规范 §2 的四层模型（Element → View → ViewTypeBinding → Composition）正式化为 **JSON Schema Draft 2020-12**，作为 DSL 的机器可读结构契约。**两份文件字节级等价**（由 JSON 程序化转储，round-trip 一致），校验逻辑通用；因项目以 YAML 为主语言，校验脚本默认优先加载 `.yaml` 版，缺失时回退 `.json`。

- 与 `docs/dsl_qweb_owl_specification.md` §2 IR **一一对应**，YAML/JSON 输入同构；
- `kind` 枚举对齐**已实现**的生成器/校验器 `KNOWN_KINDS`（`field/group/div/notebook/page/button/separator/label/header/footer/filter/subview/component/customElement/if/foreach/set/slot/dynamicAttr/call/raw`）；规范 §2 另列的 `image/html/newline/searchpanel/groupby/control` 尚未进入生成器，故暂不纳入枚举，以免放过生成器会拒绝的输入；自定义元素不扩枚举（静态枚举无法表达实例数据），统一走 `kind: customElement + ref`；
- 顶层新增 `viewTypes[]` / `viewElements[]` 两个注册表（`$defs/CustomViewType`、`$defs/CustomViewElement`、`$defs/ViewElementProp`），`Action.type` 扩展 `client` 并用 `if/then` 强制各类型必填字段；跨对象引用完整性归 IR 校验器；
- 用 `if/then` 强制各元素种类的必填字段（`field→name`、`button→string`、`filter→name`、`foreach→expr+as`、`raw→qweb+reason`、`dynamicAttr→attr+value`、`header`/`footer`→`children`、extension 视图 `→inherit` 等），并对顶层多余键 `additionalProperties:false`；
- 用 `if/then` 强制**切片的 mode 互斥**（primary 禁 `patches`/`inherit`，extension 禁 `elements`）与 **patch 的 position/载荷互斥**（`attributes` 只收 `attrs`，其余 position 只收 `elements`），`xpath` 非空；
- 断言式反例校验证明它不是 no-op（见 `schema/validate.py`）。

```bash
# 自检：schema 自洽 + 全部样例放行 + 反例拦截（默认 YAML 版 schema）
python3 schema/validate.py
# 校验单个文件
python3 schema/validate.py examples/partner_combo.yaml
# 显式指定 schema（JSON 版）
python3 schema/validate.py --schema schema/dsl_schema.json examples/partner_combo.yaml
```

> 编辑器（VS Code 等）可将 `schema/dsl_schema.yaml` 或 `schema/dsl_schema.json` 作为 YAML 的 `$schema`，获得书写期自动校验与补全。

## 图层 / 切片（Layered inheritance）

`bindings[].views[]` 不是平铺的视图列表，而是**有序继承层栈**——本仓库把 Odoo 视图继承显式化、可编排的核心概念（规范 §4.1）：

| 层 | `mode` | 内容 | 生成器产物 |
| :-- | :--- | :--- | :--- |
| 层 0（基础层 / base） | `primary` | 全量 `elements` | `ir.ui.view`（arch 根视图，无 `inherit_id`） |
| 层 k>0（切片层 / slice） | `extension` | `inherit` + `patches` | `ir.ui.view(mode=extension, inherit_id, arch=<data><xpath…/></data>)` |

**三条不变量**：

1. **层 0 恒为基础层**。切片 `inherit` 指向前序层，因此链天然无环且收敛；切片按 `priority` 升序应用，设计器以 `16 + 层索引` 自动维护，UI 调序即调整合并顺序。
2. **切片的根可以是外部基视图**。`inherit` 允许含 `.` 的字面 xml_id（如 `sale.view_order_form`），此时整个 binding 可以没有 primary（纯继承模块）；生成器直接输出 `<field name="inherit_id" ref="sale.view_order_form"/>`，校验器跳过其存在性检查并标注 `EXTERNAL_BASE_VIEW`。
3. **切片只承载增量**。`patches` 是切片唯一的内容来源，`elements` 被契约禁止（否则生成器会静默丢弃）。`position=attributes` 只收 `attrs`，其余 position 只收 `elements`（`replace` 允许空 `elements` = 删除目标节点）。

**定位铁律**：`patch.xpath` **只允许以 `@name` 作为定位键**。`@string` 是可翻译且可重复的显示标签（两个 `<group string="主要信息">` 完全合法），`@for` 亦可重复，二者都可能命中多个节点 → IR 校验器报 `PATCH_XPATH_UNSTABLE` ERROR。无 `name` 的结构容器不自动生成 xpath，应以其内部字段为锚点（如 `//field[@name="partner_id"]/..`）由作者手写；设计器点选这类容器会给出提示而不是生成不可靠的表达式。

**有效视图（effective view）** = `base arch ⊕ 所有后代切片`。生成器**不预合并**：产出的是层记录集合，合并权归 Odoo 运行时；设计器只提供「沿链预览 / 全部切片叠加」，不产出合并成品。

**校验职责划分**：结构（mode 互斥、patch 结构、position 互斥、xpath 非空）→ `schema/`；跨层引用与切片内元素（id 唯一、inherit 目标/无环/层序、未知 kind/作用域/raw/extra、定位键唯一性）→ `validator/dsl_validate.py`；arch 语法 → `rng_validate.py`；xpath 目标与字段归属 → Odoo 运行时。

```bash
# 三层继承链 + 跨模块外部基视图切片的端到端样例
python3 -m oview.pipeline examples/sale_order_layers.yaml --out outputs
python3 tests/test_layers.py      # 层栈 / 切片全链路回归
```

> 设计器中的对应操作见 `designer/README.md` 的「图层 / 切片」章节。

### 结构条 `header` / `footer`

Odoo `form` arch 的顶部条与底部条已作为**一等 DSL 元素**贯穿契约、校验、生成、反向转换与设计器（规范 §2 / §6.5）：

```yaml
elements:
  - kind: header            # 必须是根 elements 第 1 项，限 form / list
    class: o_statusbar_buttons
    children:
      - kind: button
        name: action_confirm
        string: 确认订单
        type: object
      - kind: field
        name: state
        widget: statusbar
  - kind: group
    children: [{ kind: field, name: partner_id }]
  - kind: footer            # 必须是根 elements 最后一项，仅 form
    children:
      - kind: button
        name: action_cancel
        string: 取消
        type: object
```

- 生成器按数组顺序输出 `<form><header>…</header>…<footer>…</footer></form>`，**不重排**；`class` / `groups` / `invisible` 等属性透传，`children` 递归生成。
- 反向转换把 `<header>` / `<footer>` / `<div>` / `<label>` 反转为结构化元素（只有 `sheet` 继续穿透），正→反→正 arch 逐字一致。
- IR 校验器 `ELEMENT_STRUCTURE` 拦截错位（不在首/末）、重复与嵌套；`ELEMENT_SCOPE_VIOLATION` 拦截 `footer` 出现在非 form 视图。自定义 OWL 模板（`vtype=custom`）拒绝这两种服务端原语。
- 设计器左栏可一键添加结构条，画布分别渲染状态栏区与底部按钮区，详见 `designer/README.md` 的「顶部条 / 底部条」章节。

### 布局块 `div` 与独立标签 `label`

- `div` 是通用布局容器（`{ kind: div, children: [...] }`），可嵌套字段、label、group 甚至其它 div；`class` / `groups` / `invisible` / `colspan` 等属性逐键透传到 arch。生成器递归生成子节点，反向转换不再穿透，`children` 恒输出（含空数组）。
- `label` 是独立标签（`for` 指向同表单字段名，用于显示关联），`string` / `class` / `colspan` / `nolabel` / `invisible` / `groups` / `help` 等属性完整往返；此前生成器只输出 `for` / `string`、反向把其余塞进 `extra` 而生成器不读，属性在正→反→正中丢失。
- 二者都是**共享元素**（不限 viewType），`div.children` 与主视图元素走同一套 IR 元素级校验；设计器左栏「+ 布局块 div」/「+ 标签」可一键添加，切片 patch 也能注入 div。
- **注意**：`label.for` 只用于显示关联，**不是 xpath 定位键**（定位铁律仍只允许 `@name`）；无 `name` 的 div / label 不自动生成 xpath。

## 已补全的规范缺口

| 缺口 | 状态 |
|---|---|
| **G1 生成器**（标准 + 自定义 OWL 三件套） | ✅ 已实现 |
| **G3 Composition**（view_ids / search_view_id / target / domain / context） | ✅ 已实现 |
| **B1 `dynamicAttr` map 模式** | ✅ 已修复：map 模式现生成 `t-att`（多属性），不再误生成 `t-att-{attr}` |
| **B2 未知元素种类拦截** | ✅ 已修复：`dsl_validate` 报 `ELEMENT_UNKNOWN_KIND` ERROR；生成器对未知 kind 直接抛错，不再静默 `<span>` 死节点 |
| **G3 生成器自保** | ✅ 已加固：自定义（`vtype=custom`）视图拒绝 `notebook/page/separator/filter/subview` 等服务端原语，不依赖「先校验后生成」顺序 |
| **G1/G2 自定义视图进入组合 + view_registry** | ✅ 已实现：后端 B 额外生成 `ir.ui.view(type=类型键)` 并在 JS 注册 `view_registry`；Composition 可经 `viewType: custom + ref`（旧写法）或具名注册类型引用，进入 `act_window.view_mode` 与 `ir.actions.act_window.view` |
| **G4 RNG 路径配置化 + SKIP 报告** | ✅ 已修复：`DEFAULT_RNG_DIR` 改为复用 `rng_validate`（尊重 `ODOO_RNG_DIR` 环境变量，去掉硬编码 checkout 路径）；被 SKIP 的视图类型在文末显式报告，不再静默 |
| **结构契约（JSON Schema）** | ✅ 新增：`schema/dsl_schema.json`（Draft 2020-12）形式化四层模型 + `schema/validate.py` 自检（样例放行 + 反例拦截）；可作为编辑器 `$schema` 与离线结构门禁 |
| **Fragment 体字段对齐** | ✅ 已修复：`collect_fragments` 现读规范 §2 的 `children`（权威命名），兼容旧 `elements` 写法；此前仅读 `elements` 会导致 `call` 片段静默展开为空 |
| **L1 切片层一等化** | ✅ 契约（`if/then` mode/patch 互斥）、IR 校验（`patches[].elements` 与主视图同标准）、生成器（按 position 分派、不静默降级）、反向转换（`<attribute>`→`attrs`、层栈排序）全链路对齐 |
| **跨模块 inherit** | ✅ 现为含 `.` 的字面外部基视图切片；此前降级成「缺 inherit」的非法 DSL。纯继承模块（无 primary）合法 |
| **`@name` 唯一定位键** | ✅ 禁用 `@string`/`@for`（可重复、可翻译）；IR 校验器报 `PATCH_XPATH_UNSTABLE`，设计器只给带 `name` 的元素生成 xpath，反向转换保留原文并告警 |
| **正→反→正闭环** | ✅ 修复 `to_dsl._parse_arch` 对带 XML 声明的 Unicode 字符串（lxml 抛 `ValueError`）；`pipeline → to_dsl → pipeline` 现已验证通过 |
| **`header` / `footer` 结构条** | ✅ 契约（`kind` 枚举 + `children` 必填）、IR 校验（位置/唯一/嵌套/作用域 `ELEMENT_STRUCTURE`）、生成器（顺序不重排、属性透传）、反向转换（不再穿透、结构无损）、设计器（一键添加、状态栏/底部按钮区渲染）全链路打通 |
| **`div` / `label` 元素** | ✅ `div` 从穿透容器升级为一等布局元素（递归 children、属性透传）；`label` 属性完整往返（`colspan`→integer、`nolabel`→boolean），不再只留 `for`/`string`。契约、校验、生成、反向、设计器全链路打通 |
| **三类自定义注册表** | ✅ `viewTypes[]` / `viewElements[]` / `actions[].type=client` 成为一等顶层语义；契约（`$defs` + `if/then`）、IR（`check_registry_refs` 引用完整性）、后端 B（注册表为权威生成 OWL 三件套 + view_registry + client action）、Composition（具名类型进 view_mode）、反向（`--registries` 还原 customElement 并写回注册表）、设计器（左栏注册卡片 + 画布投影）全链路打通；旧 `custom: true` 写法逐字兼容 |

## 已知限制（对应规范 §9）

- **G2（运行时侧）**：自定义视图类型键（`type`）需在真实 Odoo 模块中 `selection_add` 到 `ir.ui.view.type` 才能被原生识别；生成器已产出架构正确的 `ir.ui.view` + `view_registry` 注册骨架。
- **G4（环境侧）**：部分视图类型的 RNG 终审依赖完整 Odoo 树（如 `base/rng/form_view.rng`、`dashboard_view.rng`）。本机 checkout 缺失这些文件时优雅降级为 SKIP，并**显式报告被 SKIP 的类型**（不再静默）；配置正确的 `ODOO_RNG_DIR` 即可启用终审。
- **G4（覆盖侧）**：gantt/cohort/map 未建模；kanban `templates`、qweb 报表未专属化。
- **G6**：list 的 `editable`/`decoration-*`、graph 的 `type` 等高频项仍下沉 `extra`。
- 字段是否归属 `model`、xpath 目标是否存在，需 Odoo 运行时（生成器标注 `NEEDS_ODOO_ENV`，不阻塞离线链路）。
