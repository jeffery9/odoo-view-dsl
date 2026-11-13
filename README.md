# Odoo 统一视图 DSL · 中心仓库

> **本仓库（`odoo-view-dsl/`）是「Odoo 统一视图 DSL」项目的中心仓库（Central Repository / 唯一事实来源）。**
> 设计规范、生成器、静态校验器、参考样例**同仓共存**，不再分散于多个技能目录，从根上消除规范与实现对齐漂移。

把规范 **`docs/dsl_qweb_owl_specification.md`**（本仓库内）的「统一视图 DSL」(元素 → 视图 → 视图类型绑定 → 组合) 降低为可落地的 Odoo 产物。

## 中心仓库定位

本仓库收敛原本散落在 Odoo AI 软件工厂技能体系中的相关资产，作为统一视图 DSL 的**演进主场与权威载体**：

| 支柱 | 位置 | 职责 |
| :--- | :--- | :--- |
| **设计规范** | `docs/dsl_qweb_owl_specification.md` | 四层模型（Element → View → ViewTypeBinding → Composition）+ QWeb/OWL 定位 + 校验约束，唯一事实来源 |
| **生成器** | `oview/` | 两个编译后端：标准视图 → `ir.ui.view`；自定义视图 → OWL 三件套 |
| **静态校验器** | `validator/` | `dsl_validate`（IR 快筛）+ `rng_validate`（RNG 终审） |
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
validator/        # vendored：dsl_validate.py + rng_validate.py（来自 odoo-qweb-diagnostics）
examples/         # sale_order.json（标准+组合）、custom_widget.json（OWL）
outputs/          # 生成产物（按 module 分包）
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

> 完整可运行样例见 `examples/sale_order.yaml`（标准+组合）与 `examples/custom_widget.yaml`（自定义 OWL）。

## 已补全的规范缺口

| 缺口 | 状态 |
|---|---|
| **G1 生成器**（标准 + 自定义 OWL 三件套） | ✅ 已实现 |
| **G3 Composition**（view_ids / search_view_id / target / domain / context） | ✅ 已实现 |

## 已知限制（对应规范 §9）

- **G2**：字段是否归属 `model`、xpath 目标是否存在，需 Odoo 运行时（生成器标注 `NEEDS_ODOO_ENV`，不阻塞离线链路）。
- **G4**：视图类型覆盖不全（gantt/cohort/map 未建模；kanban `templates`、qweb 报表未专属化）。
- **G6**：list 的 `editable`/`decoration-*`、graph 的 `type` 等高频项仍下沉 `extra`。
- form 视图的 RNG 终审依赖完整 Odoo 树（`base/rng/form_view.rng`）；本机 checkout 缺失时优雅降级为 SKIP。
