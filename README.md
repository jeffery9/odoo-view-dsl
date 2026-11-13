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

# 自定义视图（OWL 组件）
python3 -m oview.pipeline examples/custom_widget.yaml --out outputs
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
```

### 转换策略（与正向生成器对称）

- **结构化映射**：`field` `group` `notebook`/`page` `button` `separator` `label` `filter` 干净反转为对应 DSL Element；属性（`string`/`widget`/`invisible`/`readonly`/`required`/`domain`/`context`/`groups`/`col`/`colspan`/`options`…）原样保留，`decoration-*` 等长尾进 `extra`。
- **`attrs` 单键提取**：`attrs="{'invisible': [...]}"` 提取为 `invisible` 字段；多键/未知键无法干净表达 → 整段 `raw` 逃逸（不丢信息）。
- **`raw` 逃逸舱**：不在 DSL 元素词汇的标签（如 `<newline>`、`<searchpanel>`）整段保留为 `raw`（必带 `reason`），保证产物通过 schema 校验且可回写为原文。
- **`header`/`sheet`/`div` 穿透**：纯布局容器无 DSL 对应概念，展开其子元素（如 header 内的 button 上提到表单顶层），避免整段 raw 把内部结构吞掉。
- **inherit → extension**：同文件内继承（`<field name="inherit_id" ref="..."/>`）反转为 `mode: extension` + `inherit` + `patches`（xpath/position 还原）；跨模块继承无法干净表达 → 整段 `raw` 并告警。
- **多视图聚合**：同一 `(model, viewType)` 的多个 ir.ui.view 自动聚成一个 ViewTypeBinding。

### 已知限制

- **`compositions` / `actions` / `menus` 不反向生成**：它们来自 Odoo 其它记录（`ir.actions.act_window` / `ir.ui.menu`），输出头部已注明「请手工补充」。
- **跨模块 inherit** 降级为 `raw` 整段（避免悬空 inherit 引用）。
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
examples/         # sale_order.yaml（标准+组合）、custom_widget.yaml（OWL）、partner_combo.yaml（组合含自定义视图 G1/G2）
outputs/          # 生成产物（按 module 分包，已被 .gitignore 忽略）
tests/            # regression.py：B1/B2/G3 回归测试（python3 tests/regression.py）
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

Element 种类：`field` `group` `notebook` `page` `button` `separator` `label`
`subview` `component` `filter`（search）`if` `foreach` `set` `slot` `dynamicAttr`
`call`（命名片段）`raw`（逃逸舱，必带 reason）。

> 完整可运行样例见 `examples/sale_order.yaml`（标准+组合）、`examples/custom_widget.yaml`（自定义 OWL）、`examples/partner_combo.yaml`（组合含自定义视图 + 菜单/动作）。

## 怎么被打开 / 挂到哪（actions + menus）

DSL 把"视图如何被打开、挂载到导航何处"也作为**一等语义组件**，与 view type / view element 并列：

- **`compositions[]`** → 视图类 opener：`ir.actions.act_window` / `client`（主流"怎么被打开"）。
- **`actions[]`**（新增）→ 非视图类 opener：`type: url`（`ir.actions.act_url`）/ `type: server`（`ir.actions.server`）。
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
- `kind` 枚举对齐**已实现**的生成器/校验器 `KNOWN_KINDS`（`field/group/notebook/page/button/separator/label/filter/subview/component/if/foreach/set/slot/dynamicAttr/call/raw`）；规范 §2 另列的 `image/html/newline/header/searchpanel/groupby/control` 尚未进入生成器，故暂不纳入枚举，以免放过生成器会拒绝的输入；
- 用 `if/then` 强制各元素种类的必填字段（`field→name`、`button→string`、`filter→name`、`foreach→expr+as`、`raw→qweb+reason`、`dynamicAttr→attr+value`、extension 视图 `→inherit` 等），并对顶层多余键 `additionalProperties:false`；
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

## 已补全的规范缺口

| 缺口 | 状态 |
|---|---|
| **G1 生成器**（标准 + 自定义 OWL 三件套） | ✅ 已实现 |
| **G3 Composition**（view_ids / search_view_id / target / domain / context） | ✅ 已实现 |
| **B1 `dynamicAttr` map 模式** | ✅ 已修复：map 模式现生成 `t-att`（多属性），不再误生成 `t-att-{attr}` |
| **B2 未知元素种类拦截** | ✅ 已修复：`dsl_validate` 报 `ELEMENT_UNKNOWN_KIND` ERROR；生成器对未知 kind 直接抛错，不再静默 `<span>` 死节点 |
| **G3 生成器自保** | ✅ 已加固：自定义（`vtype=custom`）视图拒绝 `notebook/page/separator/filter/subview` 等服务端原语，不依赖「先校验后生成」顺序 |
| **G1/G2 自定义视图进入组合 + view_registry** | ✅ 已实现：后端 B 额外生成 `ir.ui.view(type=custom 键)` 并在 JS 注册 `view_registry`；Composition 可经 `viewType: custom + ref` 引用，进入 `act_window.view_mode` 与 `ir.actions.act_window.view` |
| **G4 RNG 路径配置化 + SKIP 报告** | ✅ 已修复：`DEFAULT_RNG_DIR` 改为复用 `rng_validate`（尊重 `ODOO_RNG_DIR` 环境变量，去掉硬编码 checkout 路径）；被 SKIP 的视图类型在文末显式报告，不再静默 |
| **结构契约（JSON Schema）** | ✅ 新增：`schema/dsl_schema.json`（Draft 2020-12）形式化四层模型 + `schema/validate.py` 自检（样例放行 + 反例拦截）；可作为编辑器 `$schema` 与离线结构门禁 |
| **Fragment 体字段对齐** | ✅ 已修复：`collect_fragments` 现读规范 §2 的 `children`（权威命名），兼容旧 `elements` 写法；此前仅读 `elements` 会导致 `call` 片段静默展开为空 |

## 已知限制（对应规范 §9）

- **G2（运行时侧）**：自定义视图类型键（`type`）需在真实 Odoo 模块中 `selection_add` 到 `ir.ui.view.type` 才能被原生识别；生成器已产出架构正确的 `ir.ui.view` + `view_registry` 注册骨架。
- **G4（环境侧）**：部分视图类型的 RNG 终审依赖完整 Odoo 树（如 `base/rng/form_view.rng`、`dashboard_view.rng`）。本机 checkout 缺失这些文件时优雅降级为 SKIP，并**显式报告被 SKIP 的类型**（不再静默）；配置正确的 `ODOO_RNG_DIR` 即可启用终审。
- **G4（覆盖侧）**：gantt/cohort/map 未建模；kanban `templates`、qweb 报表未专属化。
- **G6**：list 的 `editable`/`decoration-*`、graph 的 `type` 等高频项仍下沉 `extra`。
- 字段是否归属 `model`、xpath 目标是否存在，需 Odoo 运行时（生成器标注 `NEEDS_ODOO_ENV`，不阻塞离线链路）。
