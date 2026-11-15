/* Odoo View DSL · OWL 组件化设计器（吃自己的狗食）
 * =========================================================================
 * 与 designer/ 原型「同契约、同输出」，但架构不同：
 *   原型：路径字符串寻址 + rerenderAll() 全量重渲染 + 全局单例浮动操作条。
 *   本版：节点稳定 _id 寻址 + OWL useState 细粒度响应式 + 每个 Node 组件
 *         自带 NodeToolbar / DropZone（DOM 归属正确）。
 *
 * 为什么能根除原型两类缺陷：
 *   ① 「鼠标移开菜单就消失」：工具栏是节点自身 DOM 子树，鼠标移到工具栏时
 *      e.target.closest('[data-node-id]') 仍命中该节点，焦点不转移，无需 180ms 缓冲。
 *   ② 「嵌套时外层抢走内层焦点」：closest() 取最近的 data-node-id，内层工具栏
 *      的最近宿主恒为内层节点；每个节点只有自己的工具栏实例，互不干扰。
 *   二者由 DOM 祖先关系保证，不依赖手工几何计算与祖先守卫。
 *
 * 模板约束（已由 OWL 2.3.0 实测）：模板表达式作用域不含全局对象（JSON / Object /
 * Math 等不可用），复杂计算一律放组件 getter；t-att-class 用对象或字符串形式。
 * ========================================================================= */
(function () {
  "use strict";
  const { Component, useState, xml, mount, whenReady, useRef, useEffect, onMounted, onPatched } = owl;
  const Core = window.DslCore;
  const C = {};   // 组件注册表，末尾统一回填到每个类的 static components

  // ────────────────────────── Store / Actions ──────────────────────────
  // store 本身就是 DSL spec（bindings / viewTypes / ... 位于顶层，便于 Core.locate）。
  // 所有 UI 元数据以 "_" 开头：toCleanSpec 的 replacer 会整体剥离，导出绝对干净。
  function makeStore() {
    const spec = Core.defaultSpec();
    Core.injectStateIds(spec);                 // 给每个节点注入稳定 _id
    spec._modelRegistry = JSON.parse(JSON.stringify(Core.SAMPLE_MODELS));
    spec._notebookActive = {};                 // notebook _id -> 激活页索引
    spec._ui = {
      activeB: 0, activeV: 0,
      selectedId: null,      // 检查器锚定（键盘可达）
      focusId: null,         // 鼠标焦点所在的最内层节点
      previewScope: "chain",
      previewMode: false,    // WYSIWYG 一等约束：纯预览隐藏全部编辑外壳，画布即最终 Odoo 视图
      tab: "yaml",
      rev: 0,                    // DSL 变更版本：输出 / 结构树等订阅它触发刷新
      dragField: null,
      notice: null,          // {title, body}
      schemaOk: null,        // Ajv 状态：null / "ok" / "fallback"
      schemaErrs: [],
    };
    return spec;
  }

  function createActions(store) {
    const ui = store._ui;
    const A = {};

    A.binding = () => store.bindings[ui.activeB] || null;
    A.view = () => { const b = A.binding(); return b ? (b.views || [])[ui.activeV] || null : null; };
    A.viewType = () => { const b = A.binding(); return b ? b.viewType : "form"; };
    A.isSlice = () => { const v = A.view(); return !!v && (v.mode || "primary") === "extension"; };
    A.modelDef = () => { const b = A.binding(); return b ? store._modelRegistry[b.model] || null : null; };
    A.node = (id) => { const loc = Core.locate(store, id); return loc ? loc.node : null; };
    A.loc = (id) => Core.locate(store, id);

    // 细粒度响应式对「深层数组 push/splice」不总能通知到只做 JSON 序列化的组件，
    // 故任何写操作统一递增 rev，让输出 / 检查器 / 结构树等读 rev 的组件可靠刷新。
    A.touch = () => { ui.rev++; };
    A.focus = (id) => { if (ui.focusId !== id) ui.focusId = id; };
    A.blur = () => { ui.focusId = null; };
    A.setPreview = (v) => {
      // 进入预览前记录编辑态画布宽度：隐藏侧栏后用 CSS 变量约束视图宽度，
      // 保证「编辑态所见」与「纯预览所见」逐像素一致（WYSIWYG 一等约束）。
      if (v && typeof document !== "undefined") {
        const el = document.querySelector(".o_form_view");
        const w = el && el.getBoundingClientRect().width;
        if (w > 0) document.documentElement.style.setProperty("--o_wys_width", w + "px");
      }
      ui.previewMode = !!v;
      ui.focusId = null; ui.selectedId = null;
      A.touch();
    };
    A.togglePreview = () => A.setPreview(!ui.previewMode);
    A.select = (id) => { ui.selectedId = id; if (id) ui.focusId = id; };
    A.notice = (title, body) => { ui.notice = { title: title, body: body }; };

    // 落点：把新节点插到 parentId 容器的 index 处（切片层自动重定向到 patch.elements）
    A.insertAt = (parentId, index, node) => {
      let pid = parentId, idx = index;
      if (A.isSlice()) {
        const v = A.view();
        if (!v.patches) v.patches = [];
        let pch = v.patches[0];
        if (!pch) { pch = { xpath: "", position: "inside", elements: [] }; v.patches.push(pch); }
        if (!pch.elements) pch.elements = [];
        // 切片层的落点是 patch.elements 末尾，父节点用 patch 自身（无 kind，有 elements）
        pid = pch._id || (pch._id = Core.freshId("patch"));
        idx = pch.elements.length;
      }
      const ok = Core.insertChild(store, pid, idx, node);
      if (ok) { ui.selectedId = node._id; A.touch(); }
      return ok;
    };
    A.addField = (parentId, index, name) => A.insertAt(parentId, index, { kind: "field", name: name });
    A.addKind = (parentId, index, kind) => {
      const def = Core.KIND_DEFS[kind] || {};
      const n = { kind: kind };
      (def.req || []).forEach((r) => { if (!n[r]) n[r] = kind === "field" ? "name" : "x"; });
      if (def.children) n.children = [];
      if (kind === "notebook") n.pages = [{ string: "页 1", children: [] }];
      if (kind === "group") n.string = "分组";
      if (kind === "div") n.class = "oe_title";
      if (kind === "button") { n.string = "按钮"; n.type = "object"; }
      if (kind === "separator") n.string = "分隔";
      if (kind === "label") n.string = "标签";
      if (kind === "page") n.string = "页";
      return A.insertAt(parentId, index, n);
    };
    A.remove = (id) => {
      if (Core.removeNode(store, id)) {
        if (ui.selectedId === id) ui.selectedId = null;
        if (ui.focusId === id) ui.focusId = null;
        A.touch();
        return true;
      }
      return false;
    };
    A.setProp = (id, key, val) => {
      const n = A.node(id); if (!n) return;
      if (val === "" || val == null) delete n[key]; else n[key] = val;
      A.touch();
    };
    A.move = (id, dir) => {
      const loc = A.loc(id); if (!loc || !loc.parent) return;
      const p = loc.parent;
      const arrays = [p.children, p.pages, p.elements];
      let arr = null, i = -1;
      for (const a of arrays) { if (Array.isArray(a)) { const k = a.indexOf(loc.node); if (k >= 0) { arr = a; i = k; break; } } }
      if (!arr) return;
      const j = i + dir;
      if (j < 0 || j >= arr.length) return;
      // 结构条位置固定：普通元素不得越过首 header / 末 footer
      if (Core.STRUCTURE_KINDS.indexOf(arr[i].kind) >= 0 || Core.STRUCTURE_KINDS.indexOf(arr[j].kind) >= 0) return;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      A.touch();
    };

    // 图层 / 切片
    A.addSlice = () => {
      const b = A.binding(); if (!b) return;
      const prev = (b.views || []).slice(0, ui.activeV + 1).map((v) => v.id).filter(Boolean);
      const inherit = prev.length ? prev[prev.length - 1] : "";
      const nv = { id: "slice_" + (b.views.length + 1), name: "扩展切片", mode: "extension", inherit: inherit, patches: [] };
      Core.injectIds(nv);          // 运行时新增层同样要有稳定 _id，保证按 id 寻址不退化
      b.views.push(nv);
      ui.activeV = b.views.length - 1; ui.selectedId = null; A.touch();
    };
    A.moveLayer = (i, dir) => {
      const b = A.binding(); if (!b) return;
      const j = i + dir; if (j < 0 || j >= b.views.length) return;
      const t = b.views[i]; b.views[i] = b.views[j]; b.views[j] = t;
      ui.activeV = j; A.touch();
    };
    A.removeLayer = (i) => {
      const b = A.binding(); if (!b || i === 0) return;
      b.views.splice(i, 1); ui.activeV = Math.min(ui.activeV, b.views.length - 1); ui.selectedId = null; A.touch();
    };

    // 注册表
    A.addViewType = () => {
      const n = store.viewTypes.length + 1;
      store.viewTypes.push({ id: "my_view_" + n, name: "自定义视图 " + n,
        className: "MyView" + n, template: "my_module.MyView" + n, tag: "my_module.my_view_" + n }); A.touch();
    };
    A.addViewElement = () => {
      const n = store.viewElements.length + 1;
      store.viewElements.push({ id: "my_element_" + n, tag: "MyWidget", props: [] }); A.touch();
    };
    A.addClientAction = () => {
      const n = store.actions.length + 1;
      store.actions.push({ id: "action_client_" + n, name: "自定义动作", type: "client", tag: "my_module.ClientAction" }); A.touch();
    };

    // 输出
    A.clean = () => JSON.parse(JSON.stringify(store, (k, v) => (k.startsWith("_") ? undefined : v)));
    A.yaml = () => {
      const clean = A.clean();
      try { return window.jsyaml ? window.jsyaml.dump(clean, { lineWidth: 120, noRefs: true }) : JSON.stringify(clean, null, 2); }
      catch (_) { return JSON.stringify(clean, null, 2); }
    };
    A.arch = () => Core.buildArch(store);
    A.leanErrs = () => Core.leanValidate(store);
    A.allErrs = () => {
      const lean = A.leanErrs();
      let full = [];
      if (A._schema) { try { full = A._schema(A.clean()); } catch (_) { /* schema 异常时退回 lean */ } }
      const extra = full.concat(ui.schemaErrs || []).filter((x) => lean.indexOf(x) < 0);
      return lean.concat(extra);
    };
    return A;
  }

  // 常用小工具（组件 getter 里调用，模板不直接引用全局对象）
  // ── WYSIWYG 示例数据 ──────────────────────────────────────────────
  // 只用于画布控件渲染，存放在模块常量里，不写入 spec，因此不会出现在 YAML / arch。
  const DEMO_VALUES = {
    "sale.order": {
      name: "SO-2026-001", partner_id: "Deco Addict", date_order: "2026-11-12 09:30",
      validity_date: "2026-12-31", user_id: "Mitchell Admin",
      pricelist_id: "Public Pricelist", amount_total: "12,450.00",
      note: "请于月底前交付，随货附质检报告。", client_order_ref: "PO-8891",
      state: "sale", company_id: "My Company", currency_id: "USD"
    },
    "res.partner": {
      name: "Deco Addict", email: "contact@deco.example", phone: "+1 555 0134",
      website: "https://deco.example", is_company: true, active: true,
      street: "12 Market Street", city: "New York", zip: "10001",
      country_id: "United States", company_id: "My Company",
      customer_rank: "3", credit_limit: "50,000.00"
    },
    "sale.order.line": {
      sequence: "1", name: "Office Chair Black", product_id: "Office Chair",
      product_uom_qty: "12", product_uom: "Units", price_unit: "145.00",
      discount: "5", price_subtotal: "1,653.00", price_total: "1,740.00",
      state: "sale"
    }
  };
  function demoText(v) {
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "boolean") return v ? "☑" : "☐";
    return v == null ? "" : String(v);
  }
  function demoFor(name, f, modelName) {
    const per = DEMO_VALUES[modelName] || {};
    if (per[name] !== undefined) return per[name];
    const t = f && f.type;
    if (t === "boolean") return true;
    if (t === "integer" || t === "float") return 12;
    if (t === "monetary") return "1,280.00";
    if (t === "date") return "2026-11-15";
    if (t === "datetime") return "2026-11-15 10:24";
    if (t === "selection") return (f.selection && f.selection[0][0]) || "draft";
    if (t === "many2one") return (f.relation || "关联") + " 记录";
    if (t === "many2many") return ["标签 A", "标签 B"];
    if (t === "text") return "示例文本内容。";
    return (f && f.string ? f.string : "字段") + " 示例";
  }

  const NUMERIC = ["col", "colspan", "priority", "sequence", "limit"];
  const BOOLEAN = ["nolabel"];
  const LOGIC_KINDS = ["if", "foreach", "set", "slot", "call", "dynamicAttr", "raw"];
  const ALL_ADD_KINDS = ["field", "group", "div", "notebook", "page", "button", "separator", "label", "filter", "if", "foreach", "customElement"];
  function labelOf(node, modelDef) {
    if (!node) return "";
    if (node.kind === "field") {
      const f = modelDef && Core.fieldOf(modelDef, node.name);
      return node.string || (f && f.string) || node.name || "字段";
    }
    return node.string || node.name || node.kind || "";
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ────────────────────────── DropZone ──────────────────────────
  // 每个元素前 / 每个容器末尾都有落点：默认 6px 细线，hover 时浮出工具条，
  // 不占布局高度、不淹没画布。DOM 归属自身，纯 CSS 展开，天然无抢焦问题。
  class DropZone extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get options() {
      const out = [{ value: "", label: "＋ 选择字段 / 组件…" }];
      const md = this.act.modelDef();
      if (md) md.fields.forEach((f) => out.push({ value: "field:" + f.name, label: "＋ 字段 " + f.name + "（" + f.type + "）" }));
      ALL_ADD_KINDS.filter((k) => k !== "field").forEach((k) => out.push({ value: "kind:" + k, label: "＋ 组件 " + k }));
      return out;
    }
    get isOver() { return this.store._ui.dragOver === this.key; }
    get key() { return this.props.parentId + "#" + this.props.index; }
    get cls() { return "o_drop" + (this.isOver ? " over" : ""); }
    onPick(ev) {
      const v = ev.target.value; ev.target.value = "";
      if (!v) return;
      const i = v.indexOf(":"); const t = v.slice(0, i), val = v.slice(i + 1);
      if (t === "field") this.act.addField(this.props.parentId, this.props.index, val);
      else this.act.addKind(this.props.parentId, this.props.index, val);
    }
    onDragOver(ev) { ev.preventDefault(); this.store._ui.dragOver = this.key; }
    onDragLeave() { if (this.store._ui.dragOver === this.key) this.store._ui.dragOver = null; }
    onDrop(ev) {
      ev.preventDefault(); this.store._ui.dragOver = null;
      const name = (ev.dataTransfer && ev.dataTransfer.getData("text")) || this.store._ui.dragField;
      if (name) this.act.addField(this.props.parentId, this.props.index, name);
    }
  }
  DropZone.template = xml`
    <div t-att-class="cls" t-att-data-drop="key"
         t-on-dragover="onDragOver" t-on-dragleave="onDragLeave" t-on-drop="onDrop">
      <div class="o_drop_line"></div>
      <div class="o_drop_tools">
        <select aria-label="在此插入字段或组件" t-on-change="onPick" t-on-click="(ev) => ev.stopPropagation()">
          <t t-foreach="options" t-as="opt" t-key="opt.value">
            <option t-att-value="opt.value" t-esc="opt.label"></option>
          </t>
        </select>
        <span class="o_drop_hint">拖放字段到此处</span>
      </div>
    </div>`;
  C.DropZone = DropZone;

  // ────────────────────────── NodeToolbar ──────────────────────────
  // 每个 Node 一个实例；t-if 由「最内层焦点 / 选中」决定，DOM 是节点自身后代。
  class NodeToolbar extends Component {
    setup() {
      this.store = this.props.store; this.act = this.props.act;
      this.root = useRef("toolbarRoot");
      // focusgroup 为渐进增强；原生不支持时用 roving-tabindex 提供单 tab stop + 箭头键
      if (!("focusGroup" in HTMLElement.prototype)) {
        onMounted(() => this.roving());
        onPatched(() => this.roving());
      }
    }
    roving() {
      const el = this.root.el;
      if (!el || el.dataset.roving === "1") return;
      const items = Array.from(el.querySelectorAll("button, select"));
      if (!items.length) return;
      el.dataset.roving = "1";
      let idx = 0;
      items.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
      el.addEventListener("keydown", (ev) => {
        const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
        if (keys.indexOf(ev.key) < 0) return;
        ev.preventDefault();
        idx = ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1
          : (idx + ((ev.key === "ArrowRight" || ev.key === "ArrowDown") ? 1 : -1) + items.length) % items.length;
        items.forEach((b, i) => { b.tabIndex = i === idx ? 0 : -1; });
        items[idx].focus();
      });
      el.addEventListener("focusin", (ev) => {
        const i = items.indexOf(ev.target);
        if (i >= 0) { idx = i; items.forEach((b, k) => { b.tabIndex = k === i ? 0 : -1; }); }
      });
    }
    get node() { return this.props.node; }
    get id() { return this.node._id; }
    get isContainer() { return !!(Core.KIND_DEFS[this.node.kind] || {}).children; }
    get isStructure() { return Core.STRUCTURE_KINDS.indexOf(this.node.kind) >= 0; }
    get show() {
      const ui = this.store._ui;
      // 焦点优先：任何时候最多一个工具栏，严格「只在焦点所在元素出现」。
      // 鼠标离开画布（focusId=null）时才回退到选中锚定，保证键盘可达。
      return ui.focusId ? ui.focusId === this.id : ui.selectedId === this.id;
    }
    get tag() { return this.node.kind === "field" ? this.node.name : this.node.kind; }
    get fields() {
      const md = this.act.modelDef(); return md ? md.fields : [];
    }
    onEnter() { this.act.focus(this.id); }
    stop(ev) { ev.stopPropagation(); }
    onPickField(ev) {
      ev.stopPropagation();
      const v = ev.target.value; ev.target.value = "";
      if (v) this.act.addField(this.id, null, v);
    }
    onEdit(ev) { ev.stopPropagation(); this.act.select(this.id); }
    onDelete(ev) { ev.stopPropagation(); this.act.remove(this.id); }
    onMove(ev, dir) { ev.stopPropagation(); this.act.move(this.id, dir); }
  }
  NodeToolbar.template = xml`
    <div t-if="show" class="o_node_toolbar" role="toolbar" aria-label="元素上下文操作"
         focusgroup="toolbar wrap" t-ref="toolbarRoot" t-att-data-node-id="id"
         t-on-mouseenter="onEnter" t-on-click="stop">
      <span class="o_nt_tag" t-esc="tag"></span>
      <t t-if="isContainer">
        <select class="o_nt_pick" aria-label="添加字段到此处" t-on-change="onPickField">
          <option value="">＋ 字段…</option>
          <t t-foreach="fields" t-as="f" t-key="f.name">
            <option t-att-value="f.name" t-esc="f.name + ' (' + f.type + ')'"></option>
          </t>
        </select>
      </t>
      <button type="button" title="编辑此元素" t-on-click="onEdit">✎</button>
      <t t-if="!isStructure">
        <button type="button" title="上移" t-on-click="(ev) => this.onMove(ev, -1)">▲</button>
        <button type="button" title="下移" t-on-click="(ev) => this.onMove(ev, 1)">▼</button>
      </t>
      <button type="button" class="danger" title="删除此元素" t-on-click="onDelete">🗑</button>
    </div>`;
  C.NodeToolbar = NodeToolbar;

  // ────────────────────────── FieldWidget（WYSIWYG 控件仿真） ──────────────────────────
  class FieldWidget extends Component {
    setup() { this.store = this.props.store; }
    get f() { return this.props.f; }
    get node() { return this.props.node; }
    get ctlId() { return "owl_ctl_" + this.node._id; }
    get ariaLabel() { return (this.f && this.f.string) || this.node.string || this.node.name || "字段"; }
    // 有可见 <label for> 时不写 aria-label；仅 nolabel 等无标签场景兜底
    get needsAria() { const n = this.node.nolabel; return n === true || n === 1 || n === "1"; }
    get required() { return !!(this.f && this.f.required) || this.node.required === "1" || this.node.required === 1; }
    get isLabelable() {
      const f = this.f;
      if (!f) return true;
      if (f.readonly || this.node.readonly === "1" || this.node.readonly === 1) return false;
      const t = f.type, w = String(this.w || "");
      return t !== "one2many" && t !== "many2many" && t !== "binary" &&
        w !== "statusbar" && w !== "image" && w !== "pdf_viewer";
    }
    get type() { return (this.f && this.f.type) || "char"; }
    get w() { return this.node.widget || ""; }
    get readonly() { return (this.f && this.f.readonly) || this.node.readonly === "1" || this.node.readonly === 1; }
    get demo() { return demoFor(this.node.name, this.f, this.props.modelName); }
    get value() { return demoText(this.demo); }
    get tags() { const v = this.demo; return Array.isArray(v) ? v : [demoText(v)]; }
    get checked() { const v = this.demo; return v === true || v === 1 || v === "1"; }
    get isStatusbar() { return this.w === "statusbar"; }
    get isLong() { return this.type === "text" || this.w === "html" || this.w === "text"; }
    get isSelect() { return this.type === "selection" || this.w === "selection"; }
    get isBool() { return this.type === "boolean"; }
    get isM2m() { return this.type === "many2many"; }
    get isX2m() { return this.type === "one2many"; }
    get isDate() { return this.type === "date" || this.type === "datetime"; }
    get isBinary() { return this.type === "binary" || this.w === "image" || this.w === "pdf_viewer"; }
    get isPlain() {
      return !this.readonly && !this.isStatusbar && !this.isLong && !this.isSelect &&
        !this.isBool && !this.isM2m && !this.isX2m && !this.isBinary;
    }
    get opts() { return (this.f && this.f.selection) || [["v1", "选项1"], ["v2", "选项2"]]; }
    get placeholder() {
      if (this.w === "email") return "name@example.com";
      if (this.w === "url") return "https://";
      if (this.w === "phone") return "+00 000 000";
      if (this.type === "monetary") return "0.00";
      if (this.type === "integer" || this.type === "float") return "0";
      if (this.isDate) return this.type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:MM";
      return "请输入…";
    }
    get cols() {
      const relName = this.f && this.f.relation;
      const rel = this.store._modelRegistry[relName];
      return rel ? rel.fields.slice(0, 6) : [{ name: "col1", string: "列1" }, { name: "col2", string: "列2" }];
    }
    get rows() {
      const relName = this.f && this.f.relation;
      const out = [];
      for (let r = 0; r < 2; r++) {
        out.push({ i: r, cells: this.cols.map((c) => demoText(demoFor(c.name, c, relName))) });
      }
      return out;
    }
  }
  FieldWidget.template = xml`
    <div class="o_ctl" t-att-role="isLabelable ? false : 'group'"
         t-att-aria-label="isLabelable ? false : ariaLabel">
      <t t-if="isStatusbar">
        <div class="o_statusbar_status">
          <t t-foreach="opts" t-as="o" t-key="o[0]">
            <span t-att-class="o[0] === value ? 'o_statusbar_item active' : 'o_statusbar_item'" t-esc="o[1]"></span>
          </t>
        </div>
      </t>
      <t t-elif="readonly"><span class="o_readonly_value" t-esc="value"></span></t>
      <t t-elif="isBool"><input type="checkbox" class="o_field_boolean" t-att-id="ctlId" t-att-checked="checked"
                                 t-att-aria-label="needsAria ? ariaLabel : false"/></t>
      <t t-elif="isLong"><textarea class="o_input" rows="3" readonly="readonly" t-att-id="ctlId"
                                   t-att-aria-label="needsAria ? ariaLabel : false" t-esc="value"></textarea></t>
      <t t-elif="isSelect">
        <select class="o_input" t-att-id="ctlId" t-att-aria-label="needsAria ? ariaLabel : false">
          <t t-foreach="opts" t-as="o" t-key="o[0]">
            <option t-att-value="o[0]" t-att-selected="o[0] === value" t-esc="o[1]"></option>
          </t>
        </select>
      </t>
      <t t-elif="isM2m">
        <div class="o_field_many2manytags">
          <t t-foreach="tags" t-as="tg" t-key="tg"><span class="o_tag" t-esc="tg"></span></t>
          <span class="add">+</span>
        </div>
      </t>
      <t t-elif="isX2m">
        <div class="o_list_view">
          <table class="o_list_table"><thead><tr>
            <t t-foreach="cols" t-as="c" t-key="c.name"><th t-esc="c.string || c.name"></th></t>
          </tr></thead><tbody>
            <t t-foreach="rows" t-as="r" t-key="r.i"><tr>
              <t t-foreach="r.cells" t-as="cell" t-key="cell_index"><td t-esc="cell"></td></t>
            </tr></t>
          </tbody></table>
          <div class="o_list_add">+ 添加一行</div>
        </div>
      </t>
      <t t-elif="isBinary"><div class="o_attachment">🖼 文件</div></t>
      <t t-elif="isPlain"><input class="o_input" t-att-id="ctlId" t-att-value="value"
                                  t-att-placeholder="placeholder" readonly="readonly"
                                  t-att-required="required ? 'required' : false"
                                  t-att-aria-label="needsAria ? ariaLabel : false"/></t>
    </div>`;
  C.FieldWidget = FieldWidget;

  // ────────────────────────── NodeList ──────────────────────────
  // items: [{ n: node, i: 该节点在真实数组中的索引 }]，保证 header/footer 过滤后
  // DropZone 的插入索引仍与真实 elements 对齐。
  class NodeList extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get editing() { return !this.props.store._ui.previewMode; }
  }
  // WYSIWYG：文档流里只放真实视图元素（每个 Node 一个 grid/flex item）。
  // 「元素前插入」的落点由各 Node 自身绝对定位承载；这里只在容器末尾放一个
  // 绝对定位落点。二者都不参与布局，栅格列数与真实 Odoo arch 一致。
  NodeList.template = xml`
    <t>
      <t t-foreach="props.items" t-as="item" t-key="item.n._id">
        <Node node="item.n" store="props.store" act="props.act" depth="props.depth"
              parentId="props.parentId" index="item.i"/>
      </t>
      <DropZone t-if="editing" parentId="props.parentId" index="props.endIndex"
                store="props.store" act="props.act"/>
    </t>`;
  C.NodeList = NodeList;

  // ────────────────────────── Node（递归） ──────────────────────────
  class Node extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get n() { return this.props.node; }
    get id() { return this.n._id; }
    get kind() { return this.n.kind || "?"; }
    get def() { return Core.KIND_DEFS[this.kind] || {}; }
    get isContainer() { return !!this.def.children; }
    get isStructure() { return Core.STRUCTURE_KINDS.indexOf(this.kind) >= 0; }
    get isLogic() { return LOGIC_KINDS.indexOf(this.kind) >= 0; }
    get selected() { return this.store._ui.selectedId === this.id; }
    get focus() { return this.store._ui.focusId === this.id; }
    get modelDef() { return this.act.modelDef(); }
    get modelName() { const b = this.act.binding(); return b ? b.model : ""; }
    get fieldCtlId() { return "owl_ctl_" + this.id; }
    get labelable() {
      const f = this.f;
      if (!f) return true;
      if (f.readonly || this.n.readonly === "1" || this.n.readonly === 1) return false;
      const t = f.type, w = String(this.n.widget || "");
      return t !== "one2many" && t !== "many2many" && t !== "binary" &&
        w !== "statusbar" && w !== "image" && w !== "pdf_viewer";
    }
    // XML 模板属性不能写裸 &&，复合布尔放 getter
    get showLabelFor() { return !this.hideLabel && this.labelable; }
    get editing() { return !this.store._ui.previewMode; }
    get hideLabel() {
      return this.n.widget === "statusbar" || this.n.nolabel === "1" ||
        this.n.nolabel === 1 || this.n.nolabel === true;
    }
    get customLabel() {
      const d = this.customDef;
      return (d && (d.name || d.tag)) || this.n.ref || "自定义组件";
    }
    get f() { return this.modelDef && Core.fieldOf(this.modelDef, this.n.name) || null; }
    get label() { return labelOf(this.n, this.modelDef); }
    get required() { return !!(this.f && this.f.required); }
    get invisible() { return this.n.invisible === "1" || this.n.invisible === 1 || this.n.invisible === true; }
    get typeBadge() { return this.f ? this.f.type + (this.f.relation ? " → " + this.f.relation : "") : ""; }
    get cls() {
      const c = ["o_node"];
      if (this.selected) c.push("sel");
      if (this.focus) c.push("focus");
      if (this.invisible) c.push("o_invisible_modifier");
      return c.join(" ");
    }
    get fieldCls() {
      const w = this.n.widget && String(this.n.widget).replace(/[^a-z0-9]/gi, "_");
      return "o_field_widget o_field_" + (w || (this.f ? this.f.type : "char")) + (this.selected ? " sel" : "");
    }
    get structTag() { return "<" + this.kind + ">"; }
    get divTag() { return "<div" + (this.n.class ? ' class="' + this.n.class + '"' : "") + ">"; }
    get customDef() { return Core.viewElementDef(storeOf(this), this.n.ref); }
    get customTag() { const d = this.customDef; return "⟨" + ((d && d.tag) || this.n.ref || "customElement") + "⟩"; }
    get customProps() {
      const p = this.n.props || {};
      const ks = Object.keys(p);
      if (ks.length) return ks.map((k) => k + "=" + p[k]).join("  ");
      const d = this.customDef;
      return (d && d.props && d.props.length) ? "（必填 props 待填）" : "（无 props）";
    }
    get groupCols() { const c = parseInt(this.n.col, 10); return c > 0 ? c : 2; }
    get groupStyle() { return "grid-template-columns: repeat(" + this.groupCols + ", minmax(0,1fr))"; }
    // colspan 必须作用在 grid item（.o_node 本身），而非内层控件 div
    get colspanStyle() {
      const c = parseInt(this.n.colspan, 10);
      return c > 1 ? "grid-column: span " + c : "";
    }
    get insIndex() { return this.props.index == null ? 0 : this.props.index; }
    // 子节点列表（含真实索引）
    get items() { return (this.n.children || []).map((cNode, i) => ({ n: cNode, i: i })); }
    get endIndex() { return (this.n.children || []).length; }
    get pages() {
      const ps = this.n.pages || [];
      return ps.map((p, i) => ({ p: p, i: i, title: p.string || "页 " + (i + 1) }));
    }
    get activePage() {
      const a = this.store._notebookActive[this.id];
      return a == null ? 0 : Math.min(a, Math.max(0, (this.n.pages || []).length - 1));
    }
    get pageItems() {
      const pg = (this.n.pages || [])[this.activePage];
      return (pg && pg.children || []).map((cNode, i) => ({ n: cNode, i: i }));
    }
    get pageEnd() {
      const pg = (this.n.pages || [])[this.activePage];
      return pg && pg.children ? pg.children.length : 0;
    }
    get pageParentId() {
      const pg = (this.n.pages || [])[this.activePage];
      if (!pg) return this.id;
      if (!pg._id) pg._id = Core.freshId("page");
      return pg._id;
    }
    onSelect(ev) {
      ev.stopPropagation();
      this.act.select(this.id);
    }
    // 键盘 Tab 进入节点内的控件时同样锚定焦点（WCAG 2.1.1 / 1.4.13）
    onFocusIn(ev) { ev.stopPropagation(); this.act.focus(this.id); }
    onTab(ev, i) { ev.stopPropagation(); this.store._notebookActive[this.id] = i; }
  }
  // 模板里不能引用全局对象；customDef 需要一个到 store 的引用
  function storeOf(comp) { return comp.props.store; }
  Node.template = xml`
    <div t-att-class="cls" t-att-style="colspanStyle" t-att-data-node-id="id"
         t-att-data-kind="kind" t-att-data-widget="n.widget || ''"
         t-on-click="onSelect" t-on-focusin="onFocusIn">
      <NodeToolbar t-if="editing" node="n" store="props.store" act="props.act"/>

      <t t-if="kind === 'field'">
        <div t-att-class="fieldCls">
          <label t-if="showLabelFor" t-att-for="fieldCtlId" class="o_form_label"><span t-esc="label"></span><t t-if="required"><span class="o_required"> *</span></t></label>
          <div t-elif="!hideLabel" class="o_form_label"><span t-esc="label"></span><t t-if="required"><span class="o_required"> *</span></t></div>
          <FieldWidget node="n" f="f" store="props.store" modelName="modelName"/>
        </div>
      </t>

      <t t-elif="kind === 'button'">
        <button type="button" class="btn btn-primary o_inline_btn" t-esc="label"></button>
      </t>

      <t t-elif="kind === 'separator'">
        <div class="o_horizontal_separator" t-esc="n.string || ''"></div>
      </t>

      <t t-elif="kind === 'label'">
        <div class="o_form_label o_standalone o_dsl_label"
             t-att-data-odoo-for="n.for || ''" t-att-data-odoo-class="n.class || ''">
          <span t-esc="n.string || '标签'"></span>
        </div>
      </t>

      <t t-elif="kind === 'customElement'">
        <div class="o_custom_widget" t-att-data-odoo-ref="n.ref || ''">
          <span class="o_custom_widget_label" t-esc="customLabel"></span>
          <span t-if="editing" class="o_custom_widget_tag" t-esc="customTag"></span>
          <span t-if="!customDef" class="o_custom_warn">未注册</span>
        </div>
      </t>

      <t t-elif="kind === 'div'">
        <div class="o_layout_div" t-att-data-odoo-class="n.class || ''">
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="kind === 'group' || kind === 'page'">
        <div class="o_group o_inner_group" t-att-style="groupStyle">
          <t t-if="n.string"><div class="o_horizontal_separator" t-esc="n.string"></div></t>
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="kind === 'notebook'">
        <div class="o_notebook">
          <div class="o_notebook_headers">
            <t t-foreach="pages" t-as="pg" t-key="pg.i">
              <div t-att-class="pg.i === activePage ? 'o_notebook_tab active' : 'o_notebook_tab'"
                   t-esc="pg.title" t-on-click="(ev) => this.onTab(ev, pg.i)"></div>
            </t>
          </div>
          <div class="tab-pane">
            <NodeList parentId="pageParentId" items="pageItems" endIndex="pageEnd" store="props.store" act="props.act" depth="props.depth"/>
          </div>
        </div>
      </t>

      <t t-elif="kind === 'header'">
        <div class="o_form_statusbar">
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="kind === 'footer'">
        <div class="o_form_footer_buttons">
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="isStructure">
        <div class="o_struct_children">
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="isContainer">
        <div class="o_generic_box" t-att-data-kind="kind">
          <NodeList parentId="id" items="items" endIndex="endIndex" store="props.store" act="props.act" depth="props.depth"/>
        </div>
      </t>

      <t t-elif="isLogic">
        <div t-if="editing" class="o_alert logic" t-esc="'⟨' + kind + (n.cond ? ' ' + n.cond : n.name ? ' ' + n.name : n.qweb ? ' raw' : '') + '⟩'"></div>
      </t>

      <t t-else="">
        <div t-if="editing" class="o_alert" t-esc="'▣ ' + kind"></div>
      </t>

      <!-- 每个元素都有自己的停靠区：绝对定位在节点上沿，不占布局、不改变栅格 -->
      <DropZone t-if="editing" parentId="props.parentId" index="insIndex"
                store="props.store" act="props.act"/>
    </div>`;
  C.Node = Node;

  // ────────────────────────── FormCanvas ──────────────────────────
  class FormCanvas extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get view() { return this.act.view(); }
    get isSlice() { return this.act.isSlice(); }
    // 切片层画布显示「基础层镜像」（只读），与原型一致
    get renderView() {
      const v = this.view;
      if (!this.isSlice || !v) return v;
      const b = this.act.binding();
      let ref = v.inherit;
      for (let k = this.store._ui.activeV - 1; k >= 0; k--) {
        const prev = b.views[k];
        if (prev && (prev.mode || "primary") === "primary") return prev;
      }
      if (typeof ref === "string" && ref.indexOf(".") >= 0) return v; // 外部基视图：无本地镜像
      return b.views[0] || v;
    }
    get rootId() { return (this.renderView && this.renderView._id) || ""; }
    get elements() { void this.store._ui.rev; return (this.renderView && this.renderView.elements) || []; }
    get editing() { return !this.store._ui.previewMode; }
    // 模板是 XML：属性里不能出现裸 &&（会被当成实体），复杂布尔放 getter
    get showSliceNote() { return this.isSlice && this.editing; }
    get header() { return this.elements.find((e) => e && e.kind === "header") || null; }
    get footer() { return this.elements.find((e) => e && e.kind === "footer") || null; }
    get headerIndex() { return this.elements.findIndex((e) => e && e.kind === "header"); }
    get footerIndex() { return this.elements.findIndex((e) => e && e.kind === "footer"); }
    get bodyItems() {
      return this.elements.map((e, i) => ({ n: e, i: i }))
        .filter((x) => Core.STRUCTURE_KINDS.indexOf(x.n.kind) < 0);
    }
    get endIndex() { return this.elements.length; }
    get sliceBadges() {
      if (!this.isSlice) return [];
      const out = [{ txt: "切片层 · 基础层镜像（只读）", cur: true }];
      (this.view.patches || []).forEach((p, i) =>
        out.push({ txt: "patch " + (i + 1) + " · " + (p.position || "after") + " " + (p.xpath || "(未设目标)"), cur: false }));
      return out;
    }
  }
  FormCanvas.template = xml`
    <div class="o_form_view o_form_editable">
      <t t-if="showSliceNote">
        <div class="o_slice_note">画布显示基础层镜像；在右栏「检查器」用 patches 编排修改。新组件会自动落入切片 patch.elements。</div>
        <div class="o_slice_badges">
          <t t-foreach="sliceBadges" t-as="bd" t-key="bd_index">
            <span t-att-class="bd.cur ? 'o_slice_badge current' : 'o_slice_badge'" t-esc="bd.txt"></span>
          </t>
        </div>
      </t>
      <t t-if="header">
        <div class="o_form_header_region">
          <Node node="header" store="props.store" act="props.act" depth="0"
                parentId="rootId" index="headerIndex"/>
        </div>
      </t>
      <div class="o_form_sheet_bg">
        <div class="o_form_sheet">
          <div class="o_form_sheet_body">
            <NodeList parentId="rootId" items="bodyItems" endIndex="endIndex"
                      store="props.store" act="props.act" depth="0"/>
          </div>
        </div>
      </div>
      <t t-if="footer">
        <div class="o_form_footer">
          <Node node="footer" store="props.store" act="props.act" depth="0"
                parentId="rootId" index="footerIndex"/>
        </div>
      </t>
    </div>`;
  C.FormCanvas = FormCanvas;

  // ────────────────────────── PlainCanvas（list / search / custom） ──────────────────────────
  class PlainCanvas extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get view() { return this.act.view(); }
    get rootId() { return (this.view && this.view._id) || ""; }
    get items() { void this.store._ui.rev; return ((this.view && this.view.elements) || []).map((e, i) => ({ n: e, i: i })); }
    get endIndex() { return ((this.view && this.view.elements) || []).length; }
    get vt() { return this.act.viewType(); }
    get editing() { return !this.store._ui.previewMode; }
    get isCustom() { return Core.isCustomVType(this.store, this.vt); }
    get title() {
      if (this.isCustom) return "自定义 view type · " + this.vt + "（OWL 三件套由后端 B 生成）";
      if (this.vt === "search") return "搜索视图 · 筛选 / 分组";
      return "列表视图 · " + this.vt;
    }
  }
  PlainCanvas.template = xml`
    <div class="o_form_view">
      <div t-if="editing" class="o_custom_type_banner" t-esc="title"></div>
      <div class="o_form_sheet">
        <div class="o_form_sheet_body">
          <NodeList parentId="rootId" items="items" endIndex="endIndex"
                    store="props.store" act="props.act" depth="0"/>
        </div>
        <div t-if="editing" class="muted">设计器只编排 DSL 元素；权威结果以 <code>python3 -m oview.pipeline</code> 为准。</div>
      </div>
    </div>`;
  C.PlainCanvas = PlainCanvas;

  // ────────────────────────── ViewCanvas ──────────────────────────
  // 统一用 mouseover 的 e.target.closest() 求最内层节点作为焦点。
  // 关键：工具栏 / 落点是节点 DOM 子树，移上去时 closest 仍命中该节点，
  // 焦点不转移；内层工具栏的最近宿主恒为内层，外层不会抢焦。
  class ViewCanvas extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get isForm() { const t = this.act.viewType(); return t === "form"; }
    get hasView() { return !!this.act.view(); }
    onOver(ev) {
      const t = ev.target;
      const host = t && t.closest ? t.closest("[data-node-id]") : null;
      const id = host ? host.getAttribute("data-node-id") : null;
      this.act.focus(id);
    }
    onLeave() { this.store._ui.focusId = null; }
    onClick(ev) {
      const t = ev.target;
      const host = t && t.closest ? t.closest("[data-node-id]") : null;
      if (!host) this.act.select(null);
    }
  }
  ViewCanvas.template = xml`
    <div class="o_canvas_root" t-on-mouseover="onOver" t-on-mouseleave="onLeave" t-on-click="onClick">
      <t t-if="!hasView"><div class="o_empty">无可用视图</div></t>
      <t t-elif="isForm"><FormCanvas store="props.store" act="props.act"/></t>
      <t t-else=""><PlainCanvas store="props.store" act="props.act"/></t>
    </div>`;
  C.ViewCanvas = ViewCanvas;

  // ────────────────────────── CanvasBar ──────────────────────────
  class CanvasBar extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get bindings() { void this.store._ui.rev; return this.store.bindings.map((b, i) => ({ i: i, t: b.model + " · " + b.viewType })); }
    get views() {
      const b = this.act.binding();
      return (b && b.views || []).map((v, i) => ({ i: i, t: (v.mode === "extension" ? "▤ " : "▣ ") + (v.name || v.id) }));
    }
    get activeB() { return this.store._ui.activeB; }
    get activeV() { return this.store._ui.activeV; }
    get isSlice() { return this.act.isSlice(); }
    get preview() { return this.store._ui.previewMode; }
    togglePreview() { this.act.togglePreview(); }
    onBinding(ev) { this.store._ui.activeB = +ev.target.value; this.store._ui.activeV = 0; this.act.select(null); }
    onView(ev) { this.store._ui.activeV = +ev.target.value; this.act.select(null); }
  }
  CanvasBar.template = xml`
    <div class="canvas-bar">
      <label class="cb_label">绑定</label>
      <select aria-label="编辑的 binding" t-on-change="onBinding">
        <t t-foreach="bindings" t-as="b" t-key="b.i">
          <option t-att-value="b.i" t-att-selected="b.i === activeB" t-esc="b.t"></option>
        </t>
      </select>
      <label class="cb_label">图层</label>
      <select aria-label="当前编辑的图层" t-on-change="onView">
        <t t-foreach="views" t-as="v" t-key="v.i">
          <option t-att-value="v.i" t-att-selected="v.i === activeV" t-esc="v.t"></option>
        </t>
      </select>
      <span class="hint" t-if="preview">纯预览：画布即最终 Odoo 视图，编辑外壳已隐藏</span>
      <span class="hint" t-elif="isSlice">切片层：画布为基础层镜像，修改写入 patches</span>
      <span class="hint" t-else="">悬停元素即出现 ✎ 编辑 / ＋字段 / 🗑 删除；虚线为落点</span>
      <button type="button" class="sm cb_preview" t-att-aria-pressed="preview ? 'true' : 'false'"
              t-on-click="togglePreview" t-esc="preview ? '✎ 返回编辑' : '👁 纯预览'"></button>
    </div>`;
  C.CanvasBar = CanvasBar;

  // ────────────────────────── FieldPalette / AddButtons ──────────────────────────
  // 左栏工具箱：点击字段 / 组件时落入「选中容器」或视图根末尾。
  function defaultTarget(act, store) {
    const sel = store._ui.selectedId;
    if (sel) {
      const n = act.node(sel);
      if (n && (Core.KIND_DEFS[n.kind] || {}).children) return sel;
    }
    const v = act.view();
    if (!v) return "";
    if (!v._id) v._id = Core.freshId("view");
    return v._id;
  }
  class FieldPalette extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get fields() { const md = this.act.modelDef(); return md ? md.fields : []; }
    onDragStart(ev, name) {
      this.store._ui.dragField = name;
      try { ev.dataTransfer.setData("text", name); } catch (_) {}
    }
    onDragEnd() { this.store._ui.dragField = null; }
    onClick(name) { const t = defaultTarget(this.act, this.store); if (t) this.act.addField(t, null, name); }
  }
  FieldPalette.template = xml`
    <div class="card">
      <h2>字段工具箱</h2>
      <div class="palette">
        <t t-foreach="fields" t-as="f" t-key="f.name">
          <div class="chip" draggable="true" t-esc="f.name"
               t-on-dragstart="(ev) => this.onDragStart(ev, f.name)" t-on-dragend="onDragEnd"
               t-on-click="() => this.onClick(f.name)"></div>
        </t>
      </div>
      <div class="muted">拖到画布虚线落点，或点击落入选中容器 / 视图根。</div>
    </div>`;
  C.FieldPalette = FieldPalette;

  class AddButtons extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get kinds() { return ["group", "div", "notebook", "page", "button", "separator", "label", "filter", "if", "foreach"]; }
    get canStructure() { const t = this.act.viewType(); return t === "form" || t === "list"; }
    get customDefs() { return this.store.viewElements || []; }
    onClick(kind) { const t = defaultTarget(this.act, this.store); if (t) this.act.addKind(t, null, kind); }
    addStructure(kind) {
      const v = this.act.view(); if (!v) return;
      if (!v.elements) v.elements = [];
      const exists = v.elements.some((e) => e.kind === kind);
      if (exists) { this.act.notice("结构条已存在", "每个视图根 elements 最多一个 " + kind + "。"); return; }
      const bar = { kind: kind, children: [] };
      if (kind === "header") v.elements.unshift(bar);
      else Core.appendBeforeFooter(v.elements, bar);
      Core.injectIds(bar);
      this.store._ui.selectedId = bar._id;
      this.act.touch();
    }
    addCustom(ref) {
      const t = defaultTarget(this.act, this.store); if (!t) return;
      this.act.addKind(t, null, "customElement");
    }
    addCustomRef(ref) {
      const t = defaultTarget(this.act, this.store); if (!t) return;
      this.act.insertAt(t, null, { kind: "customElement", ref: ref, props: {} });
    }
  }
  AddButtons.template = xml`
    <div class="card">
      <h2>添加组件</h2>
      <div class="addbtns">
        <t t-foreach="kinds" t-as="k" t-key="k">
          <button type="button" class="sm" t-esc="'＋ ' + k" t-on-click="() => this.onClick(k)"></button>
        </t>
      </div>
      <div class="addbtns structural">
        <span class="muted">结构条（根 elements 首 / 末）</span>
        <t t-if="canStructure">
          <button type="button" class="sm" t-on-click="() => this.addStructure('header')">＋ header</button>
          <button type="button" class="sm" t-on-click="() => this.addStructure('footer')">＋ footer</button>
        </t>
      </div>
      <div class="addbtns custom" t-if="customDefs.length">
        <span class="muted">自定义元素（先声明后引用）</span>
        <t t-foreach="customDefs" t-as="d" t-key="d.id">
          <button type="button" class="sm" t-esc="'＋ ' + d.id" t-on-click="() => this.addCustomRef(d.id)"></button>
        </t>
      </div>
    </div>`;
  C.AddButtons = AddButtons;

  // ────────────────────────── LayerPanel ──────────────────────────
  class LayerPanel extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get views() {
      const b = this.act.binding();
      return (b && b.views || []).map((v, i) => ({
        i: i, id: v.id || "", name: v.name || v.id || "层 " + i,
        slice: (v.mode || "primary") === "extension",
        inherit: v.inherit || "", active: i === this.store._ui.activeV,
      }));
    }
    onPick(i) { this.store._ui.activeV = i; this.act.select(null); }
    onInherit(ev, i) {
      const b = this.act.binding(); if (b && b.views[i]) b.views[i].inherit = ev.target.value.trim();
      this.act.touch();
    }
  }
  LayerPanel.template = xml`
    <div class="card">
      <h2>图层 / 切片</h2>
      <div class="layers">
        <t t-foreach="views" t-as="v" t-key="v.i">
          <div t-att-class="v.active ? 'layer active' : 'layer'" t-on-click="() => this.onPick(v.i)">
            <div class="layer-head">
              <span class="layer-name" t-esc="v.name"></span>
              <span t-att-class="v.slice ? 'layer-badge slice' : 'layer-badge base'" t-esc="v.slice ? '切片' : '基础层'"></span>
            </div>
            <div class="layer-meta" t-esc="v.id"></div>
            <input t-if="v.slice" class="layer-inherit" aria-label="inherit 目标" t-att-value="v.inherit"
                   t-on-change="(ev) => this.onInherit(ev, v.i)" t-on-click="(ev) => ev.stopPropagation()"/>
            <div class="layer-ctl">
              <button type="button" class="sm" title="上移" t-on-click="(ev) => { ev.stopPropagation(); this.props.act.moveLayer(v.i, -1); }">▲</button>
              <button type="button" class="sm" title="下移" t-on-click="(ev) => { ev.stopPropagation(); this.props.act.moveLayer(v.i, 1); }">▼</button>
              <button type="button" class="sm danger" title="删除" t-if="v.i > 0"
                      t-on-click="(ev) => { ev.stopPropagation(); this.props.act.removeLayer(v.i); }">✕</button>
            </div>
          </div>
        </t>
      </div>
      <button type="button" class="sm primary" t-on-click="() => this.props.act.addSlice()">＋ 切片</button>
      <div class="muted">层 0 恒为基础层；切片 inherit 指向前序层 id 或外部基视图 xml_id。</div>
    </div>`;
  C.LayerPanel = LayerPanel;

  // ────────────────────────── RegistryEditor ──────────────────────────
  class RegistryEditor extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get vtItems() { void this.store._ui.rev; return this.store.viewTypes.map((d, i) => ({ i: i, d: d })); }
    get veItems() {
      void this.store._ui.rev;
      return this.store.viewElements.map((d, i) => ({
        i: i, d: d,
        req: (d.props || []).filter((p) => p && p.required).map((p) => p.name).join(", "),
        opt: (d.props || []).filter((p) => p && !p.required).map((p) => p.name).join(", "),
      }));
    }
    get actItems() { void this.store._ui.rev; return this.store.actions.map((d, i) => ({ i: i, d: d })); }
    arr(which) {
      return which === "viewTypes" ? this.store.viewTypes
        : which === "viewElements" ? this.store.viewElements : this.store.actions;
    }
    setField(which, i, key, ev) { const d = this.arr(which)[i]; if (d) d[key] = ev.target.value; this.act.touch(); }
    removeAt(which, i) { this.arr(which).splice(i, 1); this.act.touch(); }
    setProps(which, i, kind, ev) {
      const d = this.arr(which)[i]; if (!d) return;
      const names = String(ev.target.value).split(/[,，\s]+/).filter(Boolean);
      const other = (d.props || []).filter((p) => p && !!p.required !== (kind === "req"));
      d.props = other.map((p) => ({ name: p.name, required: !!p.required }))
        .concat(names.map((nm) => ({ name: nm, required: kind === "req" })));
      this.act.touch();
    }
  }
  RegistryEditor.template = xml`
    <div class="card reg-card">
      <h2>自定义注册（先声明后引用）</h2>

      <h3>viewTypes（自定义视图类型）</h3>
      <t t-foreach="vtItems" t-as="it" t-key="it.i">
        <div class="reg-item">
          <label>id（类型键）</label>
          <input t-att-value="it.d.id || ''" t-on-input="(ev) => this.setField('viewTypes', it.i, 'id', ev)"/>
          <label>className</label>
          <input t-att-value="it.d.className || ''" t-on-input="(ev) => this.setField('viewTypes', it.i, 'className', ev)"/>
          <label>template</label>
          <input t-att-value="it.d.template || ''" t-on-input="(ev) => this.setField('viewTypes', it.i, 'template', ev)"/>
          <button type="button" class="sm danger" t-on-click="() => this.removeAt('viewTypes', it.i)">删除</button>
        </div>
      </t>
      <button type="button" class="sm" t-on-click="() => this.props.act.addViewType()">＋ 类型</button>

      <h3>viewElements（自定义元素）</h3>
      <t t-foreach="veItems" t-as="it" t-key="it.i">
        <div class="reg-item">
          <label>id（引用名）</label>
          <input t-att-value="it.d.id || ''" t-on-input="(ev) => this.setField('viewElements', it.i, 'id', ev)"/>
          <label>tag</label>
          <input t-att-value="it.d.tag || ''" t-on-input="(ev) => this.setField('viewElements', it.i, 'tag', ev)"/>
          <label>必需 props（逗号分隔）</label>
          <input t-att-value="it.req" t-on-input="(ev) => this.setProps('viewElements', it.i, 'req', ev)"/>
          <label>可选 props（逗号分隔）</label>
          <input t-att-value="it.opt" t-on-input="(ev) => this.setProps('viewElements', it.i, 'opt', ev)"/>
          <button type="button" class="sm danger" t-on-click="() => this.removeAt('viewElements', it.i)">删除</button>
        </div>
      </t>
      <button type="button" class="sm" t-on-click="() => this.props.act.addViewElement()">＋ 元素</button>

      <h3>actions（客户端动作）</h3>
      <t t-foreach="actItems" t-as="it" t-key="it.i">
        <div class="reg-item">
          <label>id</label>
          <input t-att-value="it.d.id || ''" t-on-input="(ev) => this.setField('actions', it.i, 'id', ev)"/>
          <label>name</label>
          <input t-att-value="it.d.name || ''" t-on-input="(ev) => this.setField('actions', it.i, 'name', ev)"/>
          <label>tag（type=client）</label>
          <input t-att-value="it.d.tag || ''" t-on-input="(ev) => this.setField('actions', it.i, 'tag', ev)"/>
          <button type="button" class="sm danger" t-on-click="() => this.removeAt('actions', it.i)">删除</button>
        </div>
      </t>
      <button type="button" class="sm" t-on-click="() => this.props.act.addClientAction()">＋ 动作</button>
      <div class="muted">自定义视图类型不支持 inherit 切片；引用完整性由校验器兜底。</div>
    </div>`;
  C.RegistryEditor = RegistryEditor;

  // ────────────────────────── StructTree ──────────────────────────
  class StructTree extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get lines() {
      void this.store._ui.rev;
      const out = [];
      const walk = (arr, ind) => {
        (arr || []).forEach((e) => {
          out.push({ i: out.length, t: ind + (e.kind === "field" ? "⨀ " + (e.name || "") : "▣ " + (e.kind || "?")) });
          if (e.children) walk(e.children, ind + "  ");
          (e.pages || []).forEach((pg) => {
            out.push({ i: out.length, t: ind + "  ▤ " + (pg.string || "页") });
            walk(pg.children, ind + "    ");
          });
        });
      };
      const v = this.act.view(); walk(v && v.elements, "");
      (v && v.patches || []).forEach((p, i) =>
        out.push({ i: out.length, t: "⊕ patch " + (i + 1) + " [" + (p.position || "after") + "] " + (p.xpath || "") }));
      return out;
    }
  }
  StructTree.template = xml`
    <div class="card">
      <h2>结构树</h2>
      <div class="tree">
        <t t-foreach="lines" t-as="l" t-key="l.i"><div t-esc="l.t"></div></t>
      </div>
    </div>`;
  C.StructTree = StructTree;

  // ────────────────────────── Toolbox（左栏） ──────────────────────────
  class Toolbox extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get models() { return Object.keys(this.store._modelRegistry); }
    loadSamples() {
      Object.keys(Core.SAMPLE_MODELS).forEach((k) => {
        this.store._modelRegistry[k] = clone(Core.SAMPLE_MODELS[k]);
      });
    }
    onUpload(ev) {
      const files = Array.from(ev.target.files || []);
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const d = JSON.parse(reader.result);
            if (d && typeof d.name === "string" && Array.isArray(d.fields)) this.store._modelRegistry[d.name] = d;
          } catch (_) {}
        };
        reader.readAsText(file);
      });
    }
  }
  Toolbox.template = xml`
    <div>
      <div class="card">
        <h2>模型定义</h2>
        <button type="button" class="sm" t-on-click="loadSamples">加载示例模型</button>
        <input type="file" accept=".json" multiple="multiple" aria-label="上传模型定义 JSON" t-on-change="onUpload"/>
        <div class="modlist">
          <t t-foreach="models" t-as="m" t-key="m"><div class="moditem" t-esc="m"></div></t>
        </div>
      </div>
      <FieldPalette store="props.store" act="props.act"/>
      <AddButtons store="props.store" act="props.act"/>
      <LayerPanel store="props.store" act="props.act"/>
      <RegistryEditor store="props.store" act="props.act"/>
      <StructTree store="props.store" act="props.act"/>
    </div>`;
  C.Toolbox = Toolbox;

  // ────────────────────────── PatchEditor（切片 patches） ──────────────────────────
  class PatchEditor extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get view() { return this.act.view(); }
    get patches() { void this.store._ui.rev; return (this.view && this.view.patches) || []; }
    get positions() { return Core.PATCH_POSITIONS.map((p) => ({ v: p, label: Core.posTextShort(p) })); }
    get fields() { const md = this.act.modelDef(); return md ? md.fields : []; }
    patchElems(p) { return (p.elements || []).map((e, i) => ({ e: e, i: i, t: Core.describeElem(e) })); }
    setXpath(i, ev) { if (this.patches[i]) this.patches[i].xpath = ev.target.value; this.act.touch(); }
    setPos(i, ev) {
      const p = this.patches[i]; if (!p) return;
      p.position = ev.target.value;
      if (p.position === "attributes") { if (!p.attrs) p.attrs = []; delete p.elements; }
      else { if (!p.elements) p.elements = []; delete p.attrs; }
      this.act.touch();
    }
    addElem(i, name) {
      const p = this.patches[i]; if (!p || !name) return;
      if (!p.elements) p.elements = [];
      Core.insertChild(this.store, p._id || (p._id = Core.freshId("patch")), p.elements.length, { kind: "field", name: name });
      this.act.touch();
    }
    removeElem(i, j) { const p = this.patches[i]; if (p && p.elements) p.elements.splice(j, 1); this.act.touch(); }
    addPatch() {
      const v = this.view; if (!v) return;
      if (!v.patches) v.patches = [];
      const np = { xpath: "", position: "after", elements: [] };
      np._id = window.DslCore.freshId("patch"); this.act.touch();
      v.patches.push(np);
    }
    removePatch(i) { if (this.view && this.view.patches) this.view.patches.splice(i, 1); this.act.touch(); }
  }
  PatchEditor.template = xml`
    <div class="card">
      <h2>切片修改 (patches)</h2>
      <t t-foreach="patches" t-as="p" t-key="p_index">
        <div class="patch">
          <div class="insp-title"><span t-esc="'patch ' + (p_index + 1)"></span></div>
          <label>xpath（仅 @name 稳定定位）</label>
          <input t-att-value="p.xpath || ''" t-on-input="(ev) => this.setXpath(p_index, ev)"/>
          <label>position</label>
          <select t-on-change="(ev) => this.setPos(p_index, ev)">
            <t t-foreach="positions" t-as="pos" t-key="pos.v">
              <option t-att-value="pos.v" t-att-selected="pos.v === (p.position || 'after')" t-esc="pos.label"></option>
            </t>
          </select>
          <div class="patch-elems">
            <t t-foreach="patchElems(p)" t-as="pe" t-key="pe.i">
              <span class="chip sm" t-esc="pe.t" t-on-click="() => this.removeElem(p_index, pe.i)"></span>
            </t>
          </div>
          <select aria-label="向该 patch 添加字段" t-on-change="(ev) => { this.addElem(p_index, ev.target.value); ev.target.value = ''; }">
            <option value="">＋ 字段…</option>
            <t t-foreach="fields" t-as="f" t-key="f.name">
              <option t-att-value="f.name" t-esc="f.name"></option>
            </t>
          </select>
          <button type="button" class="sm danger" t-on-click="() => this.removePatch(p_index)">删除 patch</button>
        </div>
      </t>
      <button type="button" class="sm" t-on-click="addPatch">＋ patch</button>
      <div class="muted">position=attributes ↔ attrs[]；其余 ↔ elements[]。xpath 禁止 @string / @for。</div>
    </div>`;
  C.PatchEditor = PatchEditor;

  // ────────────────────────── Inspector（右栏） ──────────────────────────
  class Inspector extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get node() { void this.store._ui.rev; return this.act.node(this.store._ui.selectedId); }
    get id() { return this.store._ui.selectedId; }
    get kind() { return this.node ? this.node.kind : ""; }
    get def() { return Core.KIND_DEFS[this.kind] || {}; }
    get propNames() {
      const out = []; const seen = {};
      (this.def.req || []).concat(this.def.opt || []).forEach((f) => {
        if (!seen[f] && f !== "children" && f !== "pages") { seen[f] = 1; out.push(f); }
      });
      return out;
    }
    get isField() { return this.kind === "field"; }
    get isCustom() { return this.kind === "customElement"; }
    get isStructure() { return Core.STRUCTURE_KINDS.indexOf(this.kind) >= 0; }
    get isContainer() { return !!this.def.children; }
    get modelFields() { const md = this.act.modelDef(); return md ? md.fields : []; }
    get widgetOpts() {
      const f = this.modelFields.find((x) => x.name === (this.node && this.node.name));
      return f ? Core.widgetSuggestions(f.type) : [];
    }
    get customDefs() { return this.store.viewElements || []; }
    get customDef() {
      const d = (this.store.viewElements || []).find((x) => x.id === (this.node && this.node.ref));
      return d || null;
    }
    get customPropNames() { return (this.customDef && this.customDef.props || []).filter((p) => p && p.name); }
    propVal(p) { const v = this.node ? this.node[p] : ""; return v == null ? "" : String(v); }
    isNumeric(p) { return NUMERIC.indexOf(p) >= 0; }
    isBoolean(p) { return BOOLEAN.indexOf(p) >= 0; }
    setProp(p, ev) {
      let v = ev.target.value;
      if (this.isNumeric(p)) v = v === "" ? "" : (parseInt(v, 10) || 1);
      if (this.isBoolean(p)) v = v === "" ? "" : (v === "1");
      this.act.setProp(this.id, p, v);
    }
    setBool(p, ev) {
      const v = ev.target.value;
      if (v === "") this.act.setProp(this.id, p, ""); else this.act.setProp(this.id, p, v === "1");
    }
    setFieldName(ev) {
      const n = this.node; if (!n) return;
      n.name = ev.target.value;
      const md = this.act.modelDef();
      const f = md && Core.fieldOf(md, n.name);
      const sug = f ? Core.widgetSuggestions(f.type) : [];
      if (n.widget && sug.length && sug.indexOf(n.widget) < 0) delete n.widget;
      this.act.touch();
    }
    setCustomRef(ev) {
      const n = this.node; if (!n) return;
      n.ref = ev.target.value;
      const d = (this.store.viewElements || []).find((x) => x.id === n.ref);
      n.props = {};
      ((d && d.props) || []).forEach((p) => { if (p && p.default !== undefined) n.props[p.name] = p.default; });
      this.act.touch();
    }
    setCustomProp(name, ev) {
      const n = this.node; if (!n) return;
      if (!n.props) n.props = {};
      if (ev.target.value === "") delete n.props[name]; else n.props[name] = ev.target.value;
      this.act.touch();
    }
    // 未选中：视图元信息
    get view() { return this.act.view(); }
    get viewTypes() { return Core.VIEW_TYPES.concat((this.store.viewTypes || []).map((d) => d.id)); }
    get currViewType() { return this.act.viewType(); }
    setViewId(ev) { if (this.view) this.view.id = ev.target.value; this.act.touch(); }
    setViewType(ev) {
      const b = this.act.binding(); if (b) b.viewType = ev.target.value;
      this.act.touch();
    }
    setInherit(ev) { if (this.view) this.view.inherit = ev.target.value.trim(); this.act.touch(); }
    get isSlice() { return this.act.isSlice(); }
  }
  Inspector.template = xml`
    <div class="card">
      <div class="insp-title"><span>检查器（显示控制）</span></div>

      <t t-if="!node">
        <div class="muted">在画布点选一个元素以编辑其属性；或用左栏字段工具箱添加。</div>
        <t t-if="view">
          <label>当前视图 id</label>
          <input t-att-value="view.id || ''" t-on-input="setViewId"/>
          <label>viewType（binding 级）</label>
          <select t-on-change="setViewType">
            <t t-foreach="viewTypes" t-as="vt" t-key="vt">
              <option t-att-value="vt" t-att-selected="vt === currViewType" t-esc="vt"></option>
            </t>
          </select>
          <div class="muted" t-esc="'mode: ' + (view.mode || 'primary') + '（由左栏图层管理）'"></div>
          <t t-if="isSlice">
            <label>inherit（前序层 id / 外部基视图 xml_id）</label>
            <input t-att-value="view.inherit || ''" t-on-input="setInherit"/>
          </t>
        </t>
      </t>

      <t t-else="">
        <div class="insp-title"><span t-esc="'▣ ' + kind"></span><span class="muted" t-esc="id"></span></div>

        <t t-if="isField">
          <label>name（模型字段）*</label>
          <select t-on-change="setFieldName">
            <option value="">（选择字段）</option>
            <t t-foreach="modelFields" t-as="f" t-key="f.name">
              <option t-att-value="f.name" t-att-selected="f.name === node.name" t-esc="f.name + ' (' + f.type + ')'"></option>
            </t>
          </select>
          <label>widget</label>
          <select t-on-change="(ev) => this.setProp('widget', ev)">
            <option value="">（默认）</option>
            <t t-foreach="widgetOpts" t-as="w" t-key="w">
              <option t-att-value="w" t-att-selected="w === node.widget" t-esc="w"></option>
            </t>
          </select>
        </t>

        <t t-if="isCustom">
          <label>ref（自定义元素）*</label>
          <select t-on-change="setCustomRef">
            <option value="">（选择注册项）</option>
            <t t-foreach="customDefs" t-as="d" t-key="d.id">
              <option t-att-value="d.id" t-att-selected="d.id === node.ref" t-esc="d.id"></option>
            </t>
          </select>
          <t t-foreach="customPropNames" t-as="cp" t-key="cp.name">
            <label t-esc="cp.name + (cp.required ? ' *' : '')"></label>
            <input t-att-value="node.props ? (node.props[cp.name] || '') : ''"
                   t-on-input="(ev) => this.setCustomProp(cp.name, ev)"/>
          </t>
        </t>

        <t t-foreach="propNames" t-as="p" t-key="p">
          <t t-if="p !== 'name' || !isField">
            <label t-esc="p"></label>
            <t t-if="isBoolean(p)">
              <select t-on-change="(ev) => this.setBool(p, ev)">
                <option value="" t-att-selected="node[p] === undefined">（未设置）</option>
                <option value="1" t-att-selected="node[p] === true || node[p] === 1">1 / true</option>
                <option value="0" t-att-selected="node[p] === false || node[p] === 0">0 / false</option>
              </select>
            </t>
            <t t-else="">
              <input t-att-type="isNumeric(p) ? 'number' : 'text'" t-att-value="propVal(p)"
                     t-on-input="(ev) => this.setProp(p, ev)"/>
            </t>
          </t>
        </t>

        <t t-if="isContainer">
          <div class="muted">容器：可在画布虚线落点拖入字段 / 组件，或用焦点工具栏「＋ 字段」。</div>
          <t t-if="kind === 'header' || kind === 'footer'">
            <div class="muted">结构条位置由 arch 顺序固定（首 / 末），不可调序。</div>
          </t>
        </t>
        <div class="row" style="margin-top:8px">
          <t t-if="!isStructure">
            <button type="button" class="sm" t-on-click="() => this.props.act.move(id, -1)">▲ 上移</button>
            <button type="button" class="sm" t-on-click="() => this.props.act.move(id, 1)">▼ 下移</button>
          </t>
          <button type="button" class="sm danger" t-on-click="() => this.props.act.remove(id)">删除</button>
        </div>
      </t>
    </div>`;
  C.Inspector = Inspector;

  // ────────────────────────── OutputPanel ──────────────────────────
  class OutputPanel extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get tab() { return this.store._ui.tab; }
    get out() {
      void this.store._ui.rev;   // 订阅 DSL 变更版本，保证输出面板刷新
      if (this.tab === "arch") return this.act.arch() || "<!-- 暂无可预览的标准视图 -->";
      if (this.tab === "json") return JSON.stringify(this.act.clean(), null, 2);
      return this.act.yaml();
    }
    get errs() { return this.act.allErrs(); }
    get statusCls() { return this.errs.length ? "status err" : "status ok"; }
    get statusText() {
      const t = this.store._ui.schemaOk;
      const suffix = t === "ok" ? "（已用 schema 权威校验）" : "（lean 校验）";
      return this.errs.length ? "✗ " + this.errs.length + " 个结构问题" + suffix
        : "✓ DSL 通过校验" + suffix;
    }
    setTab(t) { this.store._ui.tab = t; }
    copy() {
      try { navigator.clipboard.writeText(this.out); } catch (_) {}
    }
  }
  OutputPanel.template = xml`
    <div class="card">
      <h2>输出（Designer 只产出 DSL）</h2>
      <div t-att-class="statusCls">
        <span t-esc="statusText"></span>
        <ul class="errs" t-if="errs.length">
          <t t-foreach="errs.slice(0, 20)" t-as="e" t-key="e_index"><li t-esc="e"></li></t>
        </ul>
      </div>
      <div class="toolbar">
        <button type="button" t-att-class="tab === 'yaml' ? 'sm primary' : 'sm'" t-on-click="() => this.setTab('yaml')">YAML</button>
        <button type="button" t-att-class="tab === 'json' ? 'sm primary' : 'sm'" t-on-click="() => this.setTab('json')">JSON</button>
        <button type="button" t-att-class="tab === 'arch' ? 'sm primary' : 'sm'" t-on-click="() => this.setTab('arch')">arch 预览</button>
        <span class="grow"></span>
        <button type="button" class="sm" t-on-click="copy">复制</button>
      </div>
      <pre role="region" aria-label="DSL 输出" tabindex="0"><code t-esc="out"></code></pre>
      <div class="muted">权威转换请用 <code>python3 -m oview.pipeline</code>；此处 arch 仅作结构预览。</div>
    </div>`;
  C.OutputPanel = OutputPanel;

  class RightPanel extends Component {
    setup() { this.store = this.props.store; this.act = this.props.act; }
    get isSlice() { void this.store._ui.rev; return this.act.isSlice(); }
  }
  RightPanel.template = xml`
    <div>
      <Inspector store="props.store" act="props.act"/>
      <PatchEditor t-if="isSlice" store="props.store" act="props.act"/>
      <OutputPanel store="props.store" act="props.act"/>
    </div>`;
  C.RightPanel = RightPanel;

  // ────────────────────────── NoticeDialog ──────────────────────────
  class NoticeDialog extends Component {
    setup() {
      this.store = this.props.store;
      this.dlg = useRef("noticeDialog");
      // showModal() 自带 inert / 焦点 containment / Esc / 焦点返回；
      // closedby="any" 提供原生 light-dismiss，<form method="dialog"> 提供关闭按钮。
      useEffect(() => {
        const el = this.dlg.el;
        if (!el) return;
        const open = !!this.store._ui.notice;
        if (open && !el.open) el.showModal();
        if (!open && el.open) el.close();
        const onClose = () => { this.store._ui.notice = null; };
        // closedby 不可用的浏览器：按指针坐标判断 backdrop 点击（而非 event.target）
        const onBackdrop = (ev) => {
          if ("closedBy" in HTMLDialogElement.prototype || ev.target !== el) return;
          const r = el.getBoundingClientRect();
          if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) el.close();
        };
        el.addEventListener("close", onClose);
        el.addEventListener("click", onBackdrop);
        return () => { el.removeEventListener("close", onClose); el.removeEventListener("click", onBackdrop); };
      }, () => [!!this.store._ui.notice]);
    }
  }
  NoticeDialog.template = xml`
    <dialog t-ref="noticeDialog" closedby="any" aria-labelledby="noticeTitle">
      <t t-if="store._ui.notice">
        <h2 id="noticeTitle" t-esc="store._ui.notice.title"></h2>
        <p t-esc="store._ui.notice.body"></p>
        <form method="dialog"><button value="ok" autofocus="autofocus" class="sm primary">知道了</button></form>
      </t>
    </dialog>`;
  C.NoticeDialog = NoticeDialog;

  // ────────────────────────── DesignerApp（根） ──────────────────────────
  function installSchema(store, act) {
    const ui = store._ui;
    const raw = window.ajv2020 || window.ajv || window.Ajv;
    if (!raw || !window.fetch) { ui.schemaOk = "fallback"; return; }
    fetch("../schema/dsl_schema.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((schema) => {
        if (!schema) { ui.schemaOk = "fallback"; return; }
        try {
          const Ctor = raw.Ajv || raw.default || raw;
          const ajv = new Ctor({ allErrors: true, strict: false });
          const validate = ajv.compile(schema);
          act._schema = (clean) => validate(clean) ? []
            : (validate.errors || []).map((e) => (e.instancePath || "/") + " " + (e.message || ""));
          ui.schemaOk = "ok";
        } catch (_) { ui.schemaOk = "fallback"; }
      })
      .catch(() => { ui.schemaOk = "fallback"; });
  }
  class DesignerApp extends Component {
    setup() {
      this.store = useState(makeStore());
      this.act = createActions(this.store);
      installSchema(this.store, this.act);
      // 暴露给冒烟测试与控制台排查（只读用途，不参与渲染）
      if (window.DslDesigner) { window.DslDesigner.store = this.store; window.DslDesigner.act = this.act; }
    }
    get preview() { return this.store._ui.previewMode; }
  }
  DesignerApp.template = xml`
    <div t-att-class="preview ? 'owl_app o_preview' : 'owl_app'">
      <header class="app_head">
        <h1>Odoo View DSL · Designer <span class="pill">OWL components</span></h1>
        <p>组件化设计器：节点 _id 寻址 + 响应式 store；每个元素自带上下文工具栏与落点。只产出 DSL，转换交给 oview.pipeline。</p>
      </header>
      <main class="wrap">
        <div class="col left"><Toolbox store="store" act="act"/></div>
        <div class="col center">
          <CanvasBar store="store" act="act"/>
          <div class="canvas"><ViewCanvas store="store" act="act"/></div>
        </div>
        <div class="col right"><RightPanel store="store" act="act"/></div>
      </main>
      <footer class="pagefoot">
        <span>Designer 只产出 DSL；权威结果以 <code>python3 -m oview.pipeline</code> 为准。</span>
        <span>画布中 <code>header</code> / <code>footer</code> 是 Odoo arch 结构条，不是本页文档区域。</span>
      </footer>
      <NoticeDialog store="store"/>
    </div>`;
  C.DesignerApp = DesignerApp;

  // 统一回填组件表：所有类共享同一份完整映射，避免递归 / 前向引用的 TDZ 问题。
  // 此时模板尚未渲染（渲染发生在 mount 之后），赋值一定生效。
  const all = Object.assign({}, C);
  Object.keys(C).forEach((k) => { C[k].components = all; });

  window.DslDesigner = { store: null, act: null, C: C, makeStore: makeStore, createActions: createActions };

  whenReady(() => {
    const target = document.getElementById("app");
    if (!target) return;
    mount(C.DesignerApp, target, { dev: false }).then((app) => {
      window.DslDesigner.app = app;
    }).catch((err) => {
      // 挂载失败也要把原因暴露到页面，避免白屏无提示
      target.textContent = "OWL 挂载失败：" + (err && err.message || err);
      if (window.console) console.error(err);
    });
  });
})();
