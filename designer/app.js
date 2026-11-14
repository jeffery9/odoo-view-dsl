/* Odoo View DSL · Designer prototype (canvas)
 * 三栏：左=工具箱(模型/字段面板)，中=画布(所见即所得·仿真 Odoo 视图)，右=检查器+DSL。
 * 角色：把用户意图编译成 DSL（契约 = schema/dsl_schema.json）。不产出 QWeb；
 * 转换由 Python 管线 oview.pipeline 完成。
 *
 * 模型定义（model def）是「意图编译」的必要上下文：
 *   model def -> 知道有哪些字段、各自类型 -> 才能做字段摆放与显示控制。
 * 模型定义只存在于设计器（UI 上下文），不写入 DSL 产物。
 *
 * 画布仿真：中栏尽量渲染成真实 Odoo 视图的 DOM 结构与外观
 * （.o_form_view / .o_form_sheet / .o_group / .o_field_widget / .o_notebook /
 *  .o_form_statusbar 等），样式见同目录 odoo.css（近似社区浅色主题）。
 */
(function () {
  "use strict";

  // ── kind 定义 ──
  const KIND_DEFS = {
    field:       { req: ["name"], opt: ["string", "widget", "options", "colspan", "invisible", "readonly", "required", "domain", "context", "groups"], children: false },
    group:       { children: true, opt: ["string", "col", "colspan"] },
    header:      { children: true, opt: ["class", "groups", "invisible"] },
    footer:      { children: true, opt: ["class", "groups", "invisible"] },
    notebook:    { children: true },
    page:        { children: true, opt: ["string"] },
    button:      { req: ["string"], opt: ["type", "name", "icon", "groups"] },
    separator:   { opt: ["string"] },
    label:       { opt: ["string", "for", "class", "groups", "invisible", "colspan", "nolabel"] },
    div:         { children: true, opt: ["class", "string", "groups", "invisible", "colspan", "name"] },
    filter:      { req: ["name"], opt: ["string", "domain", "context", "groups"] },
    subview:     { opt: ["view_type", "mode", "ref"] },
    component:   { req: ["name"], opt: ["props", "className", "services"] },
    "if":        { req: ["cond"], children: true, opt: ["groups"] },
    foreach:    { req: ["expr", "as"], children: true, opt: ["groups"] },
    set:        { req: ["name", "value"] },
    slot:       { opt: ["name"] },
    call:       { req: ["name"], opt: ["args"] },
    dynamicAttr:{ req: ["attr", "value"], opt: ["mode"] },
    raw:        { req: ["qweb", "reason"] },
    customElement: { req: ["ref"], opt: ["props"] },
  };
  const KINDS = Object.keys(KIND_DEFS);
  const PATCH_POSITIONS = ["inside", "after", "before", "replace", "attributes"];
  const VIEW_TYPES = ["form", "list", "tree", "search", "graph", "pivot", "calendar", "activity", "dashboard",
    "kanban", "gantt", "cohort", "map", "custom"];
  const CONTAINER_KINDS = ["group", "div", "header", "footer", "notebook", "page", "if", "foreach"];
  // ── 三类自定义注册表（§2.1）：viewTypes[] / viewElements[] / actions[] ──
  const STANDARD_TYPES = VIEW_TYPES.filter((t) => t !== "custom");
  function customTypeIds() { return (state.viewTypes || []).map((t) => t.id).filter(Boolean); }
  function isCustomVType(vt) { return vt === "custom" || customTypeIds().indexOf(vt) >= 0; }
  function viewTypeDef(id) { return (state.viewTypes || []).find((d) => d.id === id) || null; }
  function viewElementDef(id) { return (state.viewElements || []).find((d) => d.id === id) || null; }
  function parseNameList(s) { return String(s || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean); }
  // arch 顺序敏感的结构条：只能是根 elements 的首 / 末元素，各最多一个
  const STRUCTURE_KINDS = ["header", "footer"];
  const STRUCTURE_SCOPE = { header: ["form", "list"], footer: ["form"] };

  // ── 模型注册表 ──
  const modelRegistry = {};
  function loadModelDefs(input) {
    const add = (d) => { if (d && typeof d.name === "string" && Array.isArray(d.fields)) modelRegistry[d.name] = d; };
    if (Array.isArray(input)) input.forEach(add);
    else if (input && typeof input === "object") {
      if (input.name && Array.isArray(input.fields)) add(input);
      else for (const k in input) add(input[k]);
    }
  }
  function getModel(name) { return modelRegistry[name] || null; }
  function fieldOf(modelDef, name) { return modelDef ? modelDef.fields.find((f) => f.name === name) || null : null; }

  const WIDGETS = {
    char: ["text", "email", "url", "phone", "password"], text: ["text", "html"], boolean: ["boolean", "boolean_toggle"],
    integer: ["integer", "handle", "priority"], float: ["float", "percentage", "progressbar"], monetary: ["monetary"],
    date: ["date"], datetime: ["datetime"], selection: ["selection", "radio", "statusbar"],
    many2one: ["many2one", "many2one_avatar", "many2one_button"], one2many: ["one2many", "list", "kanban", "form"],
    many2many: ["many2many", "many2many_tags", "many2many_binary", "kanban"], binary: ["binary", "image", "pdf_viewer"],
  };
  function widgetSuggestions(type) { return WIDGETS[type] || []; }

  const SAMPLE_MODELS = {
    "res.partner": {
      name: "res.partner", label: "联系人 / 客户",
      fields: [
        { name: "name", type: "char", string: "名称", required: true },
        { name: "email", type: "char", string: "邮箱", widget: "email" },
        { name: "phone", type: "char", string: "电话", widget: "phone" },
        { name: "website", type: "char", string: "网站", widget: "url" },
        { name: "is_company", type: "boolean", string: "是公司" },
        { name: "active", type: "boolean", string: "有效" },
        { name: "category_id", type: "many2many", string: "标签", relation: "res.partner.category" },
        { name: "company_id", type: "many2one", string: "公司", relation: "res.company" },
        { name: "country_id", type: "many2one", string: "国家", relation: "res.country" },
        { name: "street", type: "char", string: "街道" },
        { name: "city", type: "char", string: "城市" },
        { name: "zip", type: "char", string: "邮编" },
        { name: "comment", type: "text", string: "内部备注" },
        { name: "customer_rank", type: "integer", string: "客户级别" },
        { name: "credit_limit", type: "monetary", string: "信用额度", relation: "res.currency" },
        { name: "create_date", type: "datetime", string: "创建时间" }
      ]
    },
    "sale.order": {
      name: "sale.order", label: "销售订单",
      fields: [
        { name: "name", type: "char", string: "单号", readonly: true },
        { name: "partner_id", type: "many2one", string: "客户", relation: "res.partner", required: true },
        { name: "company_id", type: "many2one", string: "公司", relation: "res.company" },
        { name: "date_order", type: "datetime", string: "订单日期" },
        { name: "validity_date", type: "date", string: "报价有效期" },
        { name: "state", type: "selection", string: "状态", readonly: true, selection: [["draft", "草稿"], ["sent", "已发送"], ["sale", "销售订单"], ["done", "已完成"], ["cancel", "已取消"]] },
        { name: "user_id", type: "many2one", string: "销售员", relation: "res.users" },
        { name: "pricelist_id", type: "many2one", string: "价格表", relation: "product.pricelist" },
        { name: "order_line", type: "one2many", string: "订单明细", relation: "sale.order.line" },
        { name: "note", type: "text", string: "备注" },
        { name: "client_order_ref", type: "char", string: "客户单号" },
        { name: "amount_total", type: "monetary", string: "总计", readonly: true, relation: "res.currency" }
      ]
    },
    "sale.order.line": {
      name: "sale.order.line", label: "销售订单行",
      fields: [
        { name: "sequence", type: "integer", string: "序号" },
        { name: "name", type: "text", string: "描述" },
        { name: "order_id", type: "many2one", string: "订单", relation: "sale.order", readonly: true },
        { name: "product_id", type: "many2one", string: "产品", relation: "product.product", required: true },
        { name: "product_uom_qty", type: "float", string: "数量", required: true },
        { name: "product_uom", type: "many2one", string: "单位", relation: "uom.uom" },
        { name: "price_unit", type: "float", string: "单价" },
        { name: "discount", type: "float", string: "折扣 (%)" },
        { name: "tax_id", type: "many2many", string: "税", relation: "account.tax" },
        { name: "customer_lead", type: "float", string: "交期(天)" },
        { name: "price_subtotal", type: "monetary", string: "小计", readonly: true, relation: "res.currency" },
        { name: "price_total", type: "monetary", string: "含税总计", readonly: true, relation: "res.currency" },
        { name: "qty_delivered", type: "float", string: "已交付", readonly: true },
        { name: "qty_invoiced", type: "float", string: "已开票", readonly: true },
        { name: "state", type: "selection", string: "状态", readonly: true, selection: [["draft", "草稿"], ["sale", "销售订单"], ["cancel", "已取消"]] },
        { name: "currency_id", type: "many2one", string: "币种", relation: "res.currency", readonly: true },
        { name: "company_id", type: "many2one", string: "公司", relation: "res.company" }
      ]
    }
  };

  // ── 状态（四层模型）──
  const state = {
    module: "dsl_gen",
    // 顶层自定义注册表（§2.1）：先声明后引用，导出即 DSL 一等语义
    viewTypes: [],
    viewElements: [],
    bindings: [{
      model: "sale.order", viewType: "form",
      views: [
        {
          id: "base", mode: "primary",
          elements: [
            // header / footer 是 arch 顺序敏感的结构条：首 / 末各一个
            { kind: "header", children: [
              { kind: "button", name: "action_confirm", string: "确认订单", type: "object" },
              { kind: "button", name: "action_quotation_send", string: "发送报价", type: "object" },
              { kind: "field", name: "state", widget: "statusbar" },
            ]},
            // 通用布局块 + 独立标签（label.for 指向字段，不是 xpath 定位键）
            { kind: "div", class: "oe_title", children: [
              { kind: "label", for: "name", string: "单号", class: "o_form_label" },
              { kind: "field", name: "name", nolabel: true },
            ]},
            { kind: "group", string: "主要信息", children: [
              { kind: "field", name: "partner_id" },
              { kind: "field", name: "date_order" },
              { kind: "field", name: "user_id" },
            ]},
            { kind: "group", string: "金额", children: [
              { kind: "field", name: "pricelist_id" },
              { kind: "field", name: "amount_total" },
            ]},
            { kind: "notebook", pages: [
              { string: "订单明细", children: [ { kind: "field", name: "order_line" } ] },
              { string: "备注", children: [ { kind: "field", name: "note" } ] },
            ] },
            { kind: "footer", children: [
              { kind: "button", name: "action_save", string: "保存", type: "object" },
              { kind: "button", name: "action_cancel", string: "取消", type: "object" },
            ]},
          ],
        },
        {
          id: "slice_hide_amount", name: "隐藏金额（切片）",
          mode: "extension", inherit: "base",
          patches: [
            { xpath: "//field[@name='amount_total']", position: "attributes", attrs: [{ name: "invisible", value: "1" }] },
            { xpath: "//field[@name='note']", position: "after", elements: [{ kind: "field", name: "client_order_ref", string: "客户单号" }] },
          ],
        },
      ],
    }],
    compositions: [{ kind: "act_window", id: "action_sale", model: "sale.order", name: "销售订单", views: [{ viewType: "form" }, { viewType: "list" }], target: "current" }],
    actions: [],
    menus: [{ id: "sale_root", name: "销售" }, { id: "sale_menu", name: "销售订单", action: "action_sale", parent: "sale_root" }],
  };

  // UI-only（不进 DSL）
  let liveSchema = null;
  let selectedPath = null;          // 当前选中元素的路径
  let activeB = 0, activeV = 0;      // 画布当前编辑的 binding/view
  const notebookActive = {};         // notebook path -> 当前页索引
  let dragField = null;              // 拖拽兜底
  let pickXpathFor = null;           // {viewIdx, patchIdx}：画布取 patch 目标模式
  let pickHint = "";                 // 取目标模式下的即时提示（如「该元素无 name」）
  let previewScope = "chain";        // "chain"（到当前切片）| "all"（全部切片叠加 = 有效视图）

  // ── 工具 ──
  const $ = (s) => document.querySelector(s);
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    // 非提交按钮一律显式 type="button"，避免将来被包进 <form> 时误触发提交。
    if (tag === "button" && !(props && (props.type != null || props.value != null))) n.type = "button";
    if (props) for (const k in props) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k === "html") n.innerHTML = props[k];
      else if (k.startsWith("on") && typeof props[k] === "function") n.addEventListener(k.slice(2), props[k]);
      else if (k === "value") n.value = props[k];
      else if (props[k] != null) n.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }
  // 路径同时支持 "a.b.c" 与 "a[0].b[1]"（数组下标）
  function getPath(obj, path) { return path.replace(/\[(\d+)\]/g, ".$1").split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
  function setPath(obj, path, val) {
    const ks = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = val;
  }
  // ════════════ 层栈 / 切片工具 ════════════
  function isExternalInherit(ref) { return typeof ref === "string" && ref.indexOf(".") >= 0; }
  function isExtension(v) { return !!v && (v.mode || "primary") === "extension"; }
  function isSliceSelected() { return isExtension(getActive().view); }

  // 定位铁律：**只有 @name 是稳定且唯一的定位键**。
  // string 是可翻译、可重复的显示标签（两个 group 都叫「主要信息」完全合法），
  // label/@for 也可能重复，因此一律不得用于 xpath 定位。
  // 只有带 name 的视图元素才自动生成 xpath；无 name 的结构容器（group/page/div/
  // notebook/separator/label…）不自动生成，应以其内部带 name 的字段为锚点
  // （如 //field[@name="x"]/..）由作者手写。QWeb 指令类元素不在此列。
  const XPATH_KINDS = new Set(["field", "filter", "button", "group", "div", "label",
    "separator", "page", "notebook", "header", "footer", "subview"]);
  function xpathForElement(e) {
    if (!e || !e.kind || !e.name || !XPATH_KINDS.has(e.kind)) return null;
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    return "//" + e.kind + "[@name=" + q(e.name) + "]";
  }
  // 不稳定的定位键（可能命中多个节点）：设计器与后端校验器同步拦截
  const UNSTABLE_XPATH = /@\s*(?:string|for)\b/i;
  function targetName(xpath) {
    if (!xpath) return null;
    const m = String(xpath).match(/@name\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  }
  function describeElem(e) { return e && e.kind === "field" ? (e.name || "field") : (e && e.kind) || "?"; }
  function posTextShort(pos) {
    return { after: "之后插入", before: "之前插入", inside: "内添加", replace: "替换", attributes: "改属性" }[pos] || pos;
  }
  function defaultPatchElement(kind, modelDef) {
    const f = modelDef && modelDef.fields && modelDef.fields[0];
    switch (kind) {
      case "field": return { kind, name: f ? f.name : "name" };
      case "button": return { kind, string: "按钮", type: "object" };
      case "group": return { kind, string: "分组", children: [] };
      case "notebook": return { kind, pages: [{ string: "页 1", children: [] }] };
      case "page": return { kind, string: "页", children: [] };
      case "separator": return { kind, string: "分隔" };
      case "label": return { kind, string: "标签" };
      case "div": return { kind, class: "oe_title", children: [] };
      case "filter": return { kind, name: "my_filter", string: "我的筛选" };
      case "if": return { kind, cond: "records", children: [] };
      case "foreach": return { kind, expr: "records", as: "rec", children: [] };
      case "raw": return { kind, qweb: "<span/>", reason: "DSL 无法表达" };
      default: return { kind };
    }
  }
  // 节点打标：data-path = 编辑路径，data-xpath = 该元素作为切片目标的表达式
  function mark(node, path, e) {
    node.setAttribute("data-path", path);
    const xp = xpathForElement(e);
    if (xp) node.setAttribute("data-xpath", xp);
    // 每个画布元素都带「编辑入口」：悬浮显式操作条（✎）。
    // 用原生 <button> 触发，符合 modern-web-guidance（显式按钮 + 键盘可达 + 焦点 containment）。
    node.classList.add("o_elem_box");
    const acts = el("div", { class: "o_elem_actions", "aria-label": "元素操作" });
    const editBtn = el("button", { type: "button", class: "o_elem_btn",
      title: "编辑此元素", "aria-label": "编辑此元素", text: "✎" });
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();                 // 阻止冒泡到 #canvas 委托，避免重复选中
      selectElement(path, node.getAttribute("data-xpath"));
    });
    acts.appendChild(editBtn);
    node.appendChild(acts);
    return node;
  }

  // 原生 <dialog> 通知：showModal() 自带 inert 页面、焦点 containment、Esc 与焦点返回，
  // 因此不写 role="dialog" / aria-modal / 焦点陷阱 / Esc handler。
  function showNotice(title, message) {
    const dlg = $("#noticeDialog");
    if (!dlg || typeof dlg.showModal !== "function") {
      alert(title + "\n\n" + message);   // <dialog> 不可用时的渐进降级
      return;
    }
    $("#noticeTitle").textContent = title;
    $("#noticeBody").textContent = message;
    if (!dlg.open) dlg.showModal();
  }

  // 表单可访问性：可见 <label> 与其后的控件用 for/id 显式关联（语音识别软件依赖该关系）；
  // 仍无名字的控件补 aria-label，而不是让 title / placeholder 充当命名机制。
  let labelSeq = 0;
  function associateLabels(root) {
    if (!root || !root.querySelectorAll) return;
    const isCanvas = root.id === "canvas";
    root.querySelectorAll("label:not([for])").forEach((lab) => {
      // 两种形态：label 后紧跟控件；或 wrapping label（input 在 label 内，如「隐藏/只读/必填」）。
      // 后者虽隐式关联有效，但语音识别软件依赖显式的 for/id 关系。
      let ctrl = lab.nextElementSibling;
      if (!ctrl || !/^(INPUT|SELECT|TEXTAREA)$/.test(ctrl.tagName)) {
        ctrl = lab.querySelector("input,select,textarea");
      }
      // 画布字段控件包在 .o_ctl 里（不是 label 的相邻兄弟），补第三种形态：
      // 只在该字段容器内找控件，避免误关联到同栏的其它控件。
      if (!ctrl && lab.parentElement && lab.parentElement.classList.contains("o_field_widget")) {
        ctrl = lab.parentElement.querySelector("input,select,textarea");
      }
      if (!ctrl) return;
      if (!ctrl.id) ctrl.id = "ui-field-" + (++labelSeq);
      lab.setAttribute("for", ctrl.id);
    });
    root.querySelectorAll("input,select,textarea").forEach((ctrl) => {
      if (ctrl.getAttribute("aria-label") || ctrl.getAttribute("aria-labelledby")) return;
      if (ctrl.closest("label")) return;   // 已由 label 命名，不要用 aria-label 覆盖可见文本
      if (ctrl.id && root.querySelector('label[for="' + ctrl.id + '"]')) return;
      const host = ctrl.closest && ctrl.closest("[data-field]");
      const hint = ctrl.getAttribute("title") || ctrl.getAttribute("placeholder") ||
        (isCanvas ? "画布预览：" + ((host && host.getAttribute("data-field")) || "控件") : null);
      if (hint) ctrl.setAttribute("aria-label", hint);
    });
  }

  function uid(s) { return "dl-" + String(s).replace(/[^a-zA-Z0-9]/g, "_"); }
  function ensureFieldDatalist(modelDef) {
    const id = uid(modelDef.name); let dl = document.getElementById(id);
    if (!dl) { dl = el("datalist", { id }); modelDef.fields.forEach((f) => dl.appendChild(el("option", { value: f.name, text: f.string + " (" + f.type + ")" }))); document.body.appendChild(dl); }
    return id;
  }
  function onFieldChosen(elem, modelDef) {
    const f = fieldOf(modelDef, elem.name); if (!f) return;
    if (!elem.string) elem.string = f.string;
    if (!elem.widget) { const sug = widgetSuggestions(f.type); if (sug.length) elem.widget = sug[0]; }
  }
  function clampActive() {
    if (activeB >= state.bindings.length) activeB = Math.max(0, state.bindings.length - 1);
    const vws = (state.bindings[activeB] && state.bindings[activeB].views) || [];
    if (activeV >= vws.length) activeV = Math.max(0, vws.length - 1);
  }
  function getActive() {
    clampActive();
    const binding = state.bindings[activeB];
    const view = (binding && binding.views && binding.views[activeV]) || null;
    const modelDef = binding ? getModel(binding.model) : null;
    return { b: activeB, v: activeV, binding, view, modelName: binding && binding.model, modelDef };
  }
  // 字段「落入」目标：选中容器 -> 其 children；否则根 elements
  function getAddTargetPath() {
    const a = getActive();
    const slice = isSliceSelected();
    const inPatch = selectedPath && /\.patches\[\d+\]\.elements/.test(selectedPath);
    // 切片层选中「基础层镜像」的元素时，不能往 extension.elements 加内容
    if (selectedPath && (!slice || inPatch)) {
      const e = getPath(state, selectedPath);
      if (e && KIND_DEFS[e.kind] && KIND_DEFS[e.kind].children) {
        if (e.kind === "notebook") {
          const pages = e.pages || (e.pages = []);
          const pi = notebookActive[selectedPath] != null ? notebookActive[selectedPath] : 0;
          if (!pages[pi]) pages[pi] = { string: "页 " + (pi + 1), children: [] };
          if (!pages[pi].children) pages[pi].children = [];
          return selectedPath + ".pages[" + pi + "].children";
        }
        if (!e.children) e.children = [];
        return selectedPath + ".children";
      }
    }
    // 切片层：落进某条 patch 的 elements（生成器唯一消费的内容）
    if (slice) return sliceAddTargetPath(a.view, a.binding);
    if (a.view && !a.view.elements) a.view.elements = [];
    return "bindings[" + activeB + "].views[" + activeV + "].elements";
  }

  // 结构条位置固定：header 首 / footer 末。往根 elements 追加元素时必须插到
  // footer 之前，否则新元素把 footer 挤到中间，arch 顺序校验会报错。
  function appendBeforeFooter(arr, obj) {
    if (!Array.isArray(arr)) return false;
    const last = arr[arr.length - 1];
    if (last && last.kind === "footer") arr.splice(arr.length - 1, 0, obj);
    else arr.push(obj);
    return true;
  }
  function appendAtTarget(arrPath, obj) {
    return appendBeforeFooter(getPath(state, arrPath), obj);
  }
  // 在数组指定下标插入新元素：保持「footer 恒在末尾」不变量（插入点恰好是 footer
  // 时回退到其前；下标越界则等同末尾追加）。切片层落点被重定向到 patch，索引不再
  // 对应基础层，调用方会传 null 以走 appendAtTarget。
  function insertAtTarget(arrPath, index, obj) {
    const arr = getPath(state, arrPath);
    if (!Array.isArray(arr)) return false;
    let i = (index == null) ? arr.length : Math.max(0, Math.min(index, arr.length));
    if (i >= arr.length) return appendBeforeFooter(arr, obj);
    if (arr[i] && arr[i].kind === "footer") i = arr.length - 1;   // 不能插到 footer 之后
    if (i >= arr.length) return appendBeforeFooter(arr, obj);
    arr.splice(i, 0, obj);
    return true;
  }

  // DOM 整栏重建会移除当前焦点元素；按稳定键恢复焦点到等价控件（不做全量猜测）。
  function focusSnapshot() {
    const el = document.activeElement;
    if (!el || el === document.body || (el.closest && el.closest("dialog"))) return null;
    if (el.id) return { kind: "id", value: el.id };
    const head = el.closest && el.closest(".layer-head[data-layer-idx]");
    if (head) return { kind: "layer", value: head.getAttribute("data-layer-idx") };
    return null;
  }
  function focusRestore(snap) {
    if (!snap) return;
    const el = snap.kind === "id"
      ? document.getElementById(snap.value)
      : document.querySelector('.layer-head[data-layer-idx="' + snap.value + '"]');
    if (el && typeof el.focus === "function") el.focus();
  }

  function rerenderAll() {
    const snap = focusSnapshot();
    renderToolbox(); renderCanvas(); renderRight();
    focusRestore(snap);
  }
  function updateCanvas() { renderCanvas(); renderOutput(); }

  // ════════════ 左栏：工具箱 ════════════
  function renderModelsCard() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "Models（字段来源）" }));
    card.appendChild(el("p", { class: "muted", text: "先获得模型定义，才知道有哪些字段，进而做摆放与显示控制。可加载示例，或上传 JSON。" }));
    const loadSample = el("button", { class: "sm", text: "加载示例模型", onclick: () => { Object.values(SAMPLE_MODELS).forEach((d) => { modelRegistry[d.name] = d; }); rerenderAll(); } });
    const fileInput = el("input", { type: "file", accept: ".json", multiple: "multiple", "aria-label": "上传模型定义 JSON 文件", style: "width:auto;font-size:12px", onchange: (e) => {
      const files = Array.from(e.target.files || []); let pending = files.length; if (!pending) return;
      files.forEach((f) => { const r = new FileReader(); r.onload = () => { try { loadModelDefs(JSON.parse(r.result)); } catch (err) { showNotice("模型定义解析失败", f.name + "：" + err.message); } if (--pending === 0) rerenderAll(); }; r.readAsText(f); });
    }});
    card.appendChild(el("div", { class: "row", style: "align-items:center" }, [loadSample, fileInput]));
    const keys = Object.keys(modelRegistry);
    if (keys.length) {
      card.appendChild(el("label", { text: "已加载 " + keys.length + " 个：" }));
      const list = el("div", { class: "modlist" });
      keys.forEach((n) => list.appendChild(el("div", { class: "moditem", text: n + "（" + modelRegistry[n].fields.length + " 字段）" })));
      card.appendChild(list);
    }
    return card;
  }

  function renderPalette() {
    const card = el("div", { class: "card" });
    const a = getActive();
    card.appendChild(el("h2", { text: "字段面板（拖拽 / 点选落位）" }));
    const modelDef = a.modelDef;
    if (!modelDef) { card.appendChild(el("div", { class: "muted pad", text: "当前绑定无可用模型定义。" })); return card; }
    card.appendChild(el("p", { class: "muted", text: "模型：" + a.modelName + "（" + modelDef.label + "）。拖到画布容器，或点选落入" + (isContainerSelected() ? "选中容器" : "根") + "。" }));
    const pal = el("div", { class: "palette" });
    modelDef.fields.forEach((f) => {
      const chip = el("div", { class: "chip", draggable: "true", text: f.name }, [el("span", { class: "t", text: f.type })]);
      chip.addEventListener("dragstart", (e) => { dragField = f.name; try { e.dataTransfer.setData("text", f.name); } catch (_) {} });
      chip.addEventListener("dragend", () => { dragField = null; });
      chip.addEventListener("click", () => { if (appendAtTarget(getAddTargetPath(), { kind: "field", name: f.name })) rerenderAll(); });
      pal.appendChild(chip);
    });
    card.appendChild(pal);
    return card;
  }
  function isContainerSelected() {
    if (!selectedPath) return false;
    const e = getPath(state, selectedPath);
    return !!(e && KIND_DEFS[e.kind] && KIND_DEFS[e.kind].children);
  }

  // header/footer 只能加在基础层根 elements 的首 / 末（arch 顺序约束），且各最多一个。
  // 结构条不属于切片内容，切片层用 patches 的 xpath 去修改父 arch。
  function addStructureBar(kind) {
    const a = getActive();
    if (!a.view) return;
    if (isExtension(a.view)) {
      showNotice("只能在基础层添加", "header / footer 属于基视图 arch 结构；切片层请用 patches 的 xpath 修改父 arch。");
      return;
    }
    const vt = a.binding.viewType;
    if (STRUCTURE_SCOPE[kind].indexOf(vt) < 0) {
      showNotice("视图类型不支持", "<" + kind + "> 仅适用于 " + STRUCTURE_SCOPE[kind].join(" / ") + "，当前是 " + vt + "。");
      return;
    }
    const els = a.view.elements || (a.view.elements = []);
    if (els.some((e) => e && e.kind === kind)) {
      showNotice("结构条已存在", "同一视图只能有一个 <" + kind + ">；请在画布点选它后编辑内容。");
      return;
    }
    const bar = {
      kind,
      children: [kind === "header"
        ? { kind: "button", name: "action_confirm", string: "确认", type: "object" }
        : { kind: "button", name: "action_cancel", string: "取消", type: "object" }],
    };
    if (kind === "header") els.unshift(bar); else els.push(bar);
    selectedPath = "bindings[" + activeB + "].views[" + activeV + "].elements[" +
      (kind === "header" ? 0 : els.length - 1) + "]";
    pickXpathFor = null;
    rerenderAll();
  }

  // ════════════ 三类自定义注册表（§2.1）═══════════
  // 表单控件一律「可见 <label> + 紧跟 input」：renderToolbox 末尾的
  // associateLabels() 会补 for/id；输入时不重建左栏，避免打字丢焦点。
  function regField(labelText, value, oninput, extra) {
    const wrap = el("div", { class: "reg-field" });
    wrap.appendChild(el("label", { text: labelText }));
    const input = el("input", Object.assign(
      { value: value == null ? "" : value }, extra || {},
      { oninput: (e) => oninput(e.target.value) }));
    wrap.appendChild(input);
    wrap.input = input;
    return wrap;
  }
  function propContract(d, reqStr, optStr) {
    const old = {};
    (d.props || []).forEach((p) => { if (p && p.name) old[p.name] = p; });
    const out = parseNameList(reqStr).map((n) => Object.assign({}, old[n] || {}, { name: n, required: true }));
    parseNameList(optStr).forEach((n) => {
      if (!out.some((p) => p.name === n)) out.push(Object.assign({}, old[n] || {}, { name: n, required: false }));
    });
    d.props = out;
  }

  function renderRegistryCard() {
    const card = el("div", { class: "card reg-card" });
    card.appendChild(el("h2", { text: "自定义注册（view type / element / action）" }));
    card.appendChild(el("p", { class: "muted", text:
      "先声明后引用：view type 供 binding 引用；element 用 customElement.ref 引用；client action 显式打开 OWL 组件。DSL 只定义与接入，不替写 JS 业务逻辑。" }));

    // ── 1 · viewTypes[] ──
    card.appendChild(el("h3", { text: "1 · 自定义 view type" }));
    (state.viewTypes || []).forEach((t, i) => {
      const box = el("div", { class: "reg-item" });
      box.appendChild(regField("id（类型键）*", t.id, (v) => { t.id = v.trim(); renderOutput(); },
        { onchange: () => rerenderAll() }));
      box.appendChild(regField("name", t.name, (v) => { t.name = v; renderOutput(); }));
      box.appendChild(regField("className", t.className, (v) => { t.className = v; renderOutput(); }));
      box.appendChild(regField("tag（client action）", t.tag, (v) => { t.tag = v; renderOutput(); }));
      box.appendChild(regField("services（逗号分隔）", (t.services || []).join(", "),
        (v) => { t.services = parseNameList(v); renderOutput(); }));
      box.appendChild(regField("props（逗号分隔）", (t.props || []).join(", "),
        (v) => { t.props = parseNameList(v); renderOutput(); }));
      box.appendChild(el("button", { class: "sm danger", text: "删除此 view type", onclick: () => {
        state.viewTypes.splice(i, 1); rerenderAll();
      } }));
      card.appendChild(box);
    });
    card.appendChild(el("button", { class: "sm", text: "＋ 自定义 view type", onclick: () => {
      const n = (state.viewTypes || []).length + 1;
      (state.viewTypes || (state.viewTypes = [])).push(
        { id: "custom_view_" + n, name: "自定义视图 " + n, services: [], props: [] });
      rerenderAll();
    } }));

    // ── 2 · viewElements[] ──
    card.appendChild(el("h3", { text: "2 · 自定义 view element" }));
    (state.viewElements || []).forEach((d, i) => {
      const box = el("div", { class: "reg-item" });
      box.appendChild(regField("id（引用名）*", d.id, (v) => { d.id = v.trim(); renderOutput(); },
        { onchange: () => rerenderAll() }));
      box.appendChild(regField("tag（实际标签）", d.tag, (v) => { d.tag = v; renderOutput(); }));
      const req = (d.props || []).filter((p) => p.required).map((p) => p.name).join(", ");
      const opt = (d.props || []).filter((p) => !p.required).map((p) => p.name).join(", ");
      let reqRow, optRow;
      const sync = () => { propContract(d, reqRow.input.value, optRow.input.value); renderOutput(); };
      reqRow = regField("必需 props（逗号分隔）", req, sync);
      optRow = regField("可选 props（逗号分隔）", opt, sync);
      box.appendChild(reqRow); box.appendChild(optRow);
      box.appendChild(regField("description", d.description, (v) => { d.description = v; renderOutput(); }));
      box.appendChild(el("button", { class: "sm danger", text: "删除此元素", onclick: () => {
        state.viewElements.splice(i, 1); rerenderAll();
      } }));
      card.appendChild(box);
    });
    card.appendChild(el("button", { class: "sm", text: "＋ 自定义元素", onclick: () => {
      const n = (state.viewElements || []).length + 1;
      (state.viewElements || (state.viewElements = [])).push(
        { id: "custom_element_" + n, tag: "CustomElement" + n, props: [] });
      rerenderAll();
    } }));

    // ── 3 · actions[]（含 type=client）──
    card.appendChild(el("h3", { text: "3 · action（含自定义 client）" }));
    (state.actions || []).forEach((a, i) => {
      const box = el("div", { class: "reg-item" });
      box.appendChild(regField("id *", a.id, (v) => { a.id = v.trim(); renderOutput(); }));
      box.appendChild(regField("name", a.name, (v) => { a.name = v; renderOutput(); }));
      const tr = el("div", { class: "reg-field" });
      tr.appendChild(el("label", { text: "type" }));
      const tsel = el("select", { onchange: (e) => { a.type = e.target.value; rerenderAll(); } });
      [["url", "url（外链）"], ["server", "server（服务端）"], ["client", "client（自定义 OWL）"]]
        .forEach(([v, t]) => tsel.appendChild(el("option", { value: v, text: t,
          selected: a.type === v ? "selected" : null })));
      tr.appendChild(tsel); box.appendChild(tr);
      if (a.type === "client") {
        box.appendChild(regField("tag *", a.tag, (v) => { a.tag = v; renderOutput(); }));
        box.appendChild(regField("params（JSON）", JSON.stringify(a.params || {}), (v) => {
          try { a.params = JSON.parse(v || "{}"); } catch (err) { /* 未输入完，保留原值 */ }
          renderOutput();
        }));
        box.appendChild(regField("context", typeof a.context === "string" ? a.context : "", (v) => {
          if (v) a.context = v; else delete a.context; renderOutput();
        }));
      } else if (a.type === "server") {
        box.appendChild(regField("model *", a.model, (v) => { a.model = v; renderOutput(); }));
        box.appendChild(regField("code", a.code, (v) => { a.code = v; renderOutput(); }));
      } else {
        box.appendChild(regField("url *", a.url, (v) => { a.url = v; renderOutput(); }));
        box.appendChild(regField("target（new/self）", a.target, (v) => { a.target = v; renderOutput(); }));
      }
      box.appendChild(el("button", { class: "sm danger", text: "删除此 action", onclick: () => {
        state.actions.splice(i, 1); rerenderAll();
      } }));
      card.appendChild(box);
    });
    card.appendChild(el("button", { class: "sm", text: "＋ 自定义 action（client）", onclick: () => {
      const n = (state.actions || []).length + 1;
      (state.actions || (state.actions = [])).push(
        { id: "custom_action_" + n, type: "client", name: "自定义动作 " + n,
          tag: (state.module || "dsl_gen") + ".custom_action_" + n, params: {} });
      rerenderAll();
    } }));
    return card;
  }

  function renderAddButtons() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "添加元素（落入当前选中容器）" }));
    const add = (kind, obj) => { if (appendAtTarget(getAddTargetPath(), obj)) rerenderAll(); };
    const btns = [
      ["+ 分组", () => add("GROUP", { kind: "group", string: "分组", children: [] })],
      ["+ 布局块 div", () => add("div", { kind: "div", class: "oe_title", children: [] })],
      ["+ 笔记本", () => add("notebook", { kind: "notebook", pages: [{ string: "页 1", children: [] }] })],
      ["+ 按钮", () => add("button", { kind: "button", string: "按钮", type: "object" })],
      ["+ 分隔线", () => add("separator", { kind: "separator" })],
      ["+ 标签", () => add("label", { kind: "label", string: "标签" })],
    ];
    const wrap = el("div", { class: "addbtns" });
    btns.forEach(([t, fn]) => wrap.appendChild(el("button", { class: "sm", text: t, onclick: fn })));
    const vt = getActive().binding && getActive().binding.viewType;
    if (vt) {
      const sw = el("div", { class: "addbtns structural" });
      STRUCTURE_KINDS.forEach((k) => {
        if (STRUCTURE_SCOPE[k].indexOf(vt) < 0) return;
        sw.appendChild(el("button", { class: "sm", text: "+ " + (k === "header" ? "顶部条 header" : "底部条 footer"),
          title: "加到视图根 elements 的" + (k === "header" ? "首位" : "末尾"), onclick: () => addStructureBar(k) }));
      });
      wrap.appendChild(sw);
    }
    // 自定义元素（§2.1）：每个 viewElements[] 注册项一个按钮，按契约补 default props
    if ((state.viewElements || []).length) {
      const cw = el("div", { class: "addbtns custom" });
      state.viewElements.forEach((d) => {
        if (!d || !d.id) return;
        cw.appendChild(el("button", {
          class: "sm", text: "+ " + d.id, title: "自定义元素 → <" + (d.tag || d.id) + ">",
          onclick: () => {
            const props = {};
            (d.props || []).forEach((p) => {
              if (p && p.name && p.default !== undefined) props[p.name] = p.default;
            });
            add("customElement", { kind: "customElement", ref: d.id, props: props });
          },
        }));
      });
      wrap.appendChild(cw);
    }
    card.appendChild(wrap);
    card.appendChild(el("p", { class: "muted", text: "提示：先在画布点选一个分组/页，新元素会落进去；否则落进根。header/footer 是结构条，固定落在根首/末。" }));
    return card;
  }

  function renderTree() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "结构" }));
    const lines = [];
    (state.viewTypes || []).forEach((t) => lines.push("◈ viewType: " + (t.id || "?")));
    (state.viewElements || []).forEach((d) => lines.push("◈ element: " + (d.id || "?") + " → " + (d.tag || d.id)));
    (state.actions || []).forEach((a) => lines.push("◈ action: " + (a.id || "?") + " (" + (a.type || "url") + ")"));
    state.bindings.forEach((b, bi) => {
      lines.push((bi === activeB ? "▶ " : "  ") + "binding: " + b.model + " / " + b.viewType);
      (b.views || []).forEach((v, vi) => {
        lines.push("   " + (bi === activeB && vi === activeV ? "● " : "○ ") + v.id +
          " (" + (v.mode || "primary") + ")" + (v.inherit ? " ← " + v.inherit : ""));
        treeElems(v.elements, "     ");
        (v.patches || []).forEach((p, pi) => {
          lines.push("     ⌁ patch " + pi + " " + (p.position || "after") + " " + (p.xpath || ""));
          treeElems(p.elements, "       ");
          (p.attrs || []).forEach((a) => lines.push("       @" + (a.name || "") + "=" + (a.value || "")));
        });
      });
    });
    function treeElems(arr, ind) { (arr || []).forEach((e) => { lines.push(ind + (e.kind === "field" ? "⨀ " + e.name : "▣ " + e.kind)); if (e.children) treeElems(e.children, ind + "  "); }); }
    card.appendChild(el("div", { class: "tree", text: lines.join("\n") }));
    return card;
  }

  function renderToolbox() {
    const left = $("#left"); left.innerHTML = "";
    const mod = el("div", { class: "card" });
    mod.appendChild(el("h2", { text: "Module" }));
    mod.appendChild(el("input", { "aria-label": "模块技术名", value: state.module, oninput: (e) => { state.module = e.target.value; renderOutput(); } }));
    left.appendChild(mod);
    left.appendChild(renderLayers());
    left.appendChild(renderModelsCard());
    left.appendChild(renderPalette());
    left.appendChild(renderAddButtons());
    left.appendChild(renderRegistryCard());
    left.appendChild(renderTree());
    associateLabels(left);
  }

  // ════════════ 中栏：画布（仿真 Odoo 视图）═══════════
  function renderCanvasBar() {
    const bar = $("#canvasBar"); bar.innerHTML = "";
    const a = getActive();
    bar.appendChild(el("span", { class: "hint", text: "画布：" }));
    const bs = el("select", { "aria-label": "编辑的 binding（模型 / 视图类型）", onchange: (e) => { activeB = +e.target.value; activeV = 0; rerenderAll(); } });
    state.bindings.forEach((b, i) => bs.appendChild(el("option", { value: i, text: (b.model || "?") + " / " + b.viewType, selected: i === activeB ? "selected" : null })));
    bar.appendChild(bs);
    // 新建视图绑定：可选标准类型或已注册的自定义 view type（§2.1）
    const nts = el("select", { id: "newBindingType", "aria-label": "新绑定的视图类型" });
    VIEW_TYPES.forEach((t) => nts.appendChild(el("option", { value: t, text: t })));
    customTypeIds().forEach((t) => nts.appendChild(el("option", { value: t, text: t + "（自定义）" })));
    bar.appendChild(nts);
    bar.appendChild(el("button", { class: "sm", text: "+ 视图绑定", title: "按所选 view type 新建一个 binding",
      onclick: () => {
        const cur = getActive().binding;
        state.bindings.push({
          model: (cur && cur.model) || "unknown.model", viewType: nts.value,
          views: [{ id: "base", mode: "primary", elements: [] }],
        });
        activeB = state.bindings.length - 1; activeV = 0; selectedPath = null; rerenderAll();
      } }));
    // 主模型切换：改变当前 binding 绑定的模型，字段面板随之更新
    const modelKeys = Object.keys(modelRegistry);
    const cur = a.binding && a.binding.model;
    if (modelKeys.length) {
      if (cur && !modelKeys.includes(cur)) modelKeys.unshift(cur);
      const msel = el("select", { "aria-label": "切换主模型", title: "切换主模型（当前 binding 绑定的模型）", onchange: (e) => { if (a.binding) { a.binding.model = e.target.value || null; rerenderAll(); } } });
      bar.appendChild(el("span", { class: "hint", text: "模型" }));
      modelKeys.forEach((m) => msel.appendChild(el("option", { value: m, text: m, selected: m === cur ? "selected" : null })));
      bar.appendChild(msel);
    } else {
      bar.appendChild(el("span", { class: "hint", text: "模型：" + (cur || "（未加载，点左栏『加载示例模型』）") }));
    }
    const vs = el("select", { "aria-label": "当前编辑的图层", onchange: (e) => { activeV = +e.target.value; selectedPath = null; pickXpathFor = null; rerenderAll(); } });
    (a.binding.views || []).forEach((v, i) => vs.appendChild(el("option", { value: i, text: v.id + " (" + (v.mode || "primary") + ")", selected: i === activeV ? "selected" : null })));
    bar.appendChild(vs);
    if (isExtension(a.view)) {
      // 预览范围：沿继承链到当前切片 / 全部切片叠加（≈ effective view）
      const ps = el("select", { "aria-label": "切片预览范围", title: "切片预览范围", onchange: (e) => { previewScope = e.target.value; renderCanvas(); } });
      [["chain", "预览：沿链到当前切片"], ["all", "预览：全部切片叠加"]].forEach(([v, t]) =>
        ps.appendChild(el("option", { value: v, text: t, selected: previewScope === v ? "selected" : null })));
      bar.appendChild(ps);
    }
    if (pickXpathFor) {
      bar.appendChild(el("span", { class: "hint pick", text: pickHint || "🎯 点击带 name 的画布元素作为修改目标" }));
      bar.appendChild(el("button", { class: "sm", text: "取消选取", onclick: () => { pickXpathFor = null; pickHint = ""; rerenderAll(); } }));
    }
    associateLabels(bar);
  }

  function renderCanvas() {
    renderCanvasBody();
    // 画布里的字段标签/控件也是真实 DOM：显式 for/id 关联并给预览控件命名，
    // 避免页面出现孤立 <label> 与无名 input（modern-web-guidance forms/accessibility）。
    associateLabels($("#canvas"));
    // 仍无关联控件的仿真标签（只读值、内嵌列表）改用 <div>：它们不是表单控件的标签。
    $("#canvas").querySelectorAll("label:not([for])").forEach((lab) => {
      const div = document.createElement("div");
      div.className = lab.className;
      while (lab.firstChild) div.appendChild(lab.firstChild);
      lab.replaceWith(div);
    });
  }
  function renderCanvasBody() {
    const cv = $("#canvas"); cv.innerHTML = "";
    const a = getActive();
    if (!a.view) { cv.appendChild(el("div", { class: "o_empty", text: "无可用视图" })); return; }
    const vt = a.binding.viewType;

    if (isCustomVType(vt)) {
      cv.appendChild(renderCustomViewSheet(a));
      renderCanvasBar(); return;
    }
    if (vt === "list" || vt === "tree") { cv.appendChild(renderListSheet(a)); renderCanvasBar(); return; }
    if (vt === "search") { cv.appendChild(renderSearchSheet(a)); renderCanvasBar(); return; }

    // ── form：仿真 Odoo 表单（header → statusbar / sheet / footer）──
    const fv = el("div", { class: "o_form_view o_form_editable" });
    // 切片层（extension）：画布渲染「基础层」元素，再叠加该切片的修改预览
    const isSlice = (a.view.mode || "primary") === "extension";
    const baseLayer = isSlice ? layerBaseView(a.binding) : null;
    const baseIdx = baseLayer ? baseLayer.idx : activeV;
    const renderView = baseLayer ? baseLayer.view : a.view;
    const base = "bindings[" + activeB + "].views[" + baseIdx + "]";
    const rootEls = renderView.elements || [];
    const headerIdx = rootEls.findIndex((e) => e && e.kind === "header");
    const footerIdx = rootEls.findIndex((e) => e && e.kind === "footer");

    if (headerIdx >= 0) {
      fv.appendChild(renderHeaderBar(a, rootEls[headerIdx], base + ".elements[" + headerIdx + "]"));
    } else {
      // 兼容旧 DSL：没有显式 header 时，根层 button 仍自动上提为状态栏
      const statusButtons = [];
      rootEls.forEach((e, i) => { if (e.kind === "button") statusButtons.push({ e, p: base + ".elements[" + i + "]" }); });
      const hasStatus = statusButtons.length ||
        (a.modelDef && a.modelDef.fields.some((f) => f.name === "state" && f.type === "selection" && Array.isArray(f.selection)));
      if (hasStatus) fv.appendChild(renderStatusbar(a, statusButtons));
    }

    const sheetBg = el("div", { class: "o_form_sheet_bg" });
    const sheet = el("div", { class: "o_form_sheet" });
    const body = el("div", { class: "o_form_sheet_body" });
    const bodyEls = [];
    rootEls.forEach((e, i) => {
      if (e.kind === "header" || e.kind === "footer") return;   // 结构条已单独渲染
      if (e.kind === "button" && headerIdx < 0) return;          // 旧兼容：已上提到状态栏
      bodyEls.push({ e, i });
    });
    // 每个根元素前穿插停靠区（按根下标插入，保持 footer 恒在末尾），末尾再补一个
    bodyEls.forEach(({ e, i }) => {
      body.appendChild(renderDropzone(base + ".elements", a.modelDef, i));
      body.appendChild(canvasElem(e, base + ".elements[" + i + "]", a.modelName, 0));
    });
    body.appendChild(renderDropzone(base + ".elements", a.modelDef, rootEls.length));
    sheet.appendChild(body);
    sheetBg.appendChild(sheet);
    fv.appendChild(sheetBg);
    if (footerIdx >= 0) {
      fv.appendChild(renderFooterBar(a, rootEls[footerIdx], base + ".elements[" + footerIdx + "]"));
    }
    if (isSlice) {
      // 沿层栈叠加：默认显示到当前切片为止的祖先切片；"all" 显示全部（≈ effective view）
      previewSlices(a.binding).forEach((s) =>
        applySlicePreview(fv, s.view, { current: s.idx === activeV, label: s.view.name || s.view.id }));
    }
    cv.appendChild(fv);
    renderCanvasBar();
  }

  // 自定义 view type 的画布：呈现该类型的元素编排（OWL 模板由后端 B 生成，
  // 设计器不产出 QWeb）。用 <div> 承载，不制造第二个 banner landmark。
  function renderCustomViewSheet(a) {
    const fv = el("div", { class: "o_form_view" });
    const tdef = viewTypeDef(a.binding.viewType);
    fv.appendChild(el("div", { class: "o_custom_type_banner", text:
      "自定义 view type · " + a.binding.viewType +
      (tdef && tdef.className ? " → " + tdef.className : "") }));
    const sheet = el("div", { class: "o_form_sheet" });
    const base = "bindings[" + activeB + "].views[" + activeV + "]";
    appendChildren(sheet, base + ".elements", a.view.elements, a.modelName, 0);
    sheet.appendChild(el("div", { class: "muted", text:
      "OWL 三件套（.js/.xml/.scss）由后端 B 生成；画布只呈现元素编排，权威结果请用 python3 -m oview.pipeline。" }));
    fv.appendChild(sheet);
    return fv;
  }

  // 结构条仿真节点一律用 <div>：它们是被编辑视图的可视化投影，不是本页的
  // 文档区域。用真实 <header>/<footer> 会产生第二个 banner/contentinfo landmark。
  function structureTag(kind) {
    return el("span", { class: "o_struct_tag", text: "<" + kind + ">" });
  }
  function statusPills(a, fieldElem) {
    const f = a.modelDef && a.modelDef.fields.find((x) => x.name === (fieldElem && fieldElem.name));
    const opts = (f && Array.isArray(f.selection)) ? f.selection : [["draft", "草稿"], ["done", "完成"]];
    const st = el("div", { class: "o_statusbar_status" });
    opts.forEach((opt, i) => st.appendChild(el("span", {
      class: "o_statusbar_item" + (i === 0 ? " active" : ""), text: opt[1],
    })));
    return st;
  }
  function renderHeaderBar(a, elem, path) {
    const wrap = el("div", { class: "o_form_header_region" + (path === selectedPath ? " sel" : "") });
    mark(wrap, path, elem);
    wrap.appendChild(structureTag("header"));
    const bar = el("div", { class: "o_form_statusbar" });
    (elem.children || []).forEach((c, ci) => {
      // 每个子元素前都穿插一个停靠区（按位置插入），保证每个元素都可直接接收新组件
      bar.appendChild(renderDropzone(path + ".children", a.modelDef, ci));
      const cp = path + ".children[" + ci + "]";
      if (c.kind === "field" && (c.widget === "statusbar" || c.name === "state")) {
        bar.appendChild(mark(statusPills(a, c), cp, c));
      } else {
        bar.appendChild(canvasElem(c, cp, a.modelName, 0));
      }
    });
    bar.appendChild(renderDropzone(path + ".children", a.modelDef, (elem.children || []).length));
    wrap.appendChild(bar);
    if (!(elem.children || []).some((c) => c.kind === "field" && (c.widget === "statusbar" || c.name === "state"))) {
      const sf = a.modelDef && a.modelDef.fields.find((f) => f.name === "state" && f.type === "selection" && Array.isArray(f.selection));
      if (sf) bar.appendChild(statusPills(a, { name: "state" }));
    }
    return wrap;
  }
  function renderFooterBar(a, elem, path) {
    const box = el("div", { class: "o_form_footer" + (path === selectedPath ? " sel" : "") });
    mark(box, path, elem);
    box.appendChild(structureTag("footer"));
    const row = el("div", { class: "o_form_footer_buttons" });
    appendChildren(row, path + ".children", elem.children, a.modelName, 0);
    box.appendChild(row);
    return box;
  }

  function renderStatusbar(a, buttons) {
    const bar = el("div", { class: "o_form_statusbar" });
    const btns = el("div", { class: "o_statusbar_buttons" });
    buttons.forEach(({ e, p }) => {
      const cls = "btn " + (e.type === "danger" ? "btn-danger" : (e.type === "secondary" ? "btn-secondary" : "btn-primary"));
      const b = mark(el("button", { class: cls, text: e.string || "按钮" }), p, e);
      btns.appendChild(b);
    });
    bar.appendChild(btns);
    const sf = a.modelDef && a.modelDef.fields.find((f) => f.name === "state" && f.type === "selection" && Array.isArray(f.selection));
    if (sf) {
      const st = el("div", { class: "o_statusbar_status" });
      sf.selection.forEach((opt, i) => st.appendChild(el("span", { class: "o_statusbar_item" + (i === 0 ? " active" : ""), text: opt[1] })));
      bar.appendChild(st);
    }
    return bar;
  }

  function renderListSheet(a) {
    const wrap = el("div", { class: "o_form_view" });
    const sheet = el("div", { class: "o_form_sheet" });
    const modelDef = a.modelDef;
    const view = el("div", { class: "o_list_view" });
    const table = el("table", { class: "o_list_table" });
    const thead = el("thead"); const htr = el("tr");
    const cols = modelDef ? modelDef.fields.slice(0, 7) : [{ name: "c1", string: "列1" }, { name: "c2", string: "列2" }];
    cols.forEach((c) => htr.appendChild(el("th", { text: c.string || c.name })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");
    for (let r = 0; r < 3; r++) { const tr = el("tr"); cols.forEach((c) => tr.appendChild(el("td", { text: listCellSample(c, r) }))); tb.appendChild(tr); }
    table.appendChild(tb); view.appendChild(table);
    view.appendChild(el("div", { class: "o_list_add", text: "+ 添加一行" }));
    sheet.appendChild(view);
    wrap.appendChild(sheet);
    return wrap;
  }
  function listCellSample(c, r) {
    const t = c.type;
    if (t === "boolean") return r % 2 ? "☑" : "☐";
    if (t === "selection") return c.selection ? c.selection[r % c.selection.length][1] : "选项";
    if (t === "many2one" || t === "many2many") return (c.string || c.name) + "…";
    if (t === "monetary" || t === "float" || t === "integer") return "0.00";
    if (t === "date" || t === "datetime") return "2026-01-0" + (r + 1);
    return (c.string || c.name) + " " + (r + 1);
  }
  function renderSearchSheet(a) {
    const wrap = el("div", { class: "o_form_view" });
    const sheet = el("div", { class: "o_form_sheet" });
    const panel = el("div", { class: "o_search_panel" });
    panel.appendChild(el("div", { class: "o_search_title", text: "搜索视图（筛选 / 分组）" }));
    const filters = (a.view.elements || []).filter((e) => e.kind === "filter");
    const fg = el("div", { class: "o_search_filters" });
    if (!filters.length) fg.appendChild(el("div", { class: "o_alert", text: "（无 filter 元素）" }));
    filters.forEach((f, i) => {
      const chip = el("span", { class: "o_search_chip", text: f.string || f.name });
      mark(chip, "bindings[" + activeB + "].views[" + activeV + "].elements[" + i + "]", f);
      fg.appendChild(chip);
    });
    panel.appendChild(fg);
    sheet.appendChild(panel);
    wrap.appendChild(sheet);
    return wrap;
  }

  // 字段控件（仿真 Odoo widget）
  function oFieldControl(f, elem) {
    const type = (f && f.type) || "char";
    const w = elem.widget;
    const ctl = el("div", { class: "o_ctl" });
    const readonly = (f && f.readonly) || elem.readonly === "1";
    if (readonly) { ctl.appendChild(el("span", { class: "o_readonly_value", text: readonlySample(f, w) })); return ctl; }
    if (type === "boolean") { ctl.appendChild(el("input", { type: "checkbox", class: "o_field_boolean" })); return ctl; }
    if (type === "text" || w === "html" || w === "text") { ctl.appendChild(el("textarea", { class: "o_input", rows: "3", placeholder: "请输入…" })); return ctl; }
    if (type === "selection" || w === "selection") {
      const sel = el("select", { class: "o_input" });
      const opts = (f && f.selection) || [["v1", "选项1"], ["v2", "选项2"]];
      opts.forEach((o) => sel.appendChild(el("option", { value: o[0], text: o[1] })));
      ctl.appendChild(sel); return ctl;
    }
    if (w === "radio" && type === "selection") {
      const rg = el("div", { class: "o_radio_group" });
      (f.selection || [["v1", "选1"], ["v2", "选2"]]).forEach((o) => {
        const lab = el("label", { class: "o_radio" });
        lab.appendChild(el("input", { type: "radio", name: "r" + Math.random().toString(36).slice(2) }));
        lab.appendChild(document.createTextNode(" " + o[1]));
        rg.appendChild(lab);
      });
      ctl.appendChild(rg); return ctl;
    }
    if (type === "many2many") {
      const tags = el("div", { class: "o_field_many2manytags" });
      (f && f.relation ? [f.relation + " 记录"] : ["标签"]).forEach((t) => {
        const tag = el("span", { class: "o_tag" }, [document.createTextNode(t), el("span", { class: "x", text: "×" })]);
        tags.appendChild(tag);
      });
      tags.appendChild(el("span", { class: "add", text: "+" }));
      ctl.appendChild(tags); return ctl;
    }
    if (type === "one2many") { ctl.appendChild(renderListPreview(f && f.relation)); return ctl; }
    if (type === "date" || type === "datetime") {
      const dp = el("div", { class: "o_datepicker" });
      dp.appendChild(el("input", { class: "o_input", placeholder: type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:MM" }));
      ctl.appendChild(dp); return ctl;
    }
    if (type === "binary" || w === "image" || w === "pdf_viewer") { ctl.appendChild(el("div", { class: "o_attachment", text: "🖼 文件" })); return ctl; }
    const inp = el("input", { class: "o_input", placeholder: placeholderFor(type, w) });
    if (type === "monetary" || type === "float" || type === "integer") inp.style.textAlign = "right";
    ctl.appendChild(inp);
    return ctl;
  }
  function placeholderFor(type, w) {
    if (w === "email") return "name@example.com";
    if (w === "url") return "https://";
    if (w === "phone") return "+00 000 000";
    if (type === "monetary") return "0.00";
    if (type === "integer" || type === "float") return "0";
    if (type === "char") return "请输入…";
    return "";
  }
  function readonlySample(f, w) {
    const t = f && f.type;
    if (t === "boolean") return "是";
    if (t === "selection") return (f.selection && f.selection[0] && f.selection[0][1]) || "选项";
    if (t === "many2one") return (f.relation || "关联") + " 记录";
    if (t === "many2many") return (f.relation || "关联") + " ×N";
    if (t === "monetary" || t === "float" || t === "integer") return "0.00";
    if (t === "date" || t === "datetime") return "2026-01-01";
    return "示例值";
  }
  function renderListPreview(relation) {
    const rel = getModel(relation);
    const wrap = el("div", { class: "o_list_view" });
    const table = el("table", { class: "o_list_table" });
    const thead = el("thead"); const htr = el("tr");
    const cols = rel ? rel.fields.slice(0, 6) : [{ name: "col1", string: "列1" }, { name: "col2", string: "列2" }];
    cols.forEach((c) => htr.appendChild(el("th", { text: c.string || c.name })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");
    for (let r = 0; r < 2; r++) { const tr = el("tr"); cols.forEach((c) => tr.appendChild(el("td", { text: listCellSample(c, r) }))); tb.appendChild(tr); }
    table.appendChild(tb); wrap.appendChild(table);
    wrap.appendChild(el("div", { class: "o_list_add", text: "+ 添加一行" }));
    return wrap;
  }

  function canvasElem(elem, path, modelName, depth) {
    const isSel = path === selectedPath;
    const modelDef = getModel(modelName);

    // 逻辑类（非可视字段）以标注呈现
    if (["if", "foreach", "set", "slot", "call", "dynamicAttr", "raw"].includes(elem.kind)) {
      return mark(el("div", { class: "o_alert logic" + (isSel ? " sel" : ""), text: "⟨" + elem.kind + (elem.cond ? " " + elem.cond : elem.name ? " " + elem.name : elem.qweb ? " raw" : "") + "⟩" }), path, elem);
    }

    if (elem.kind === "field") {
      const f = fieldOf(modelDef, elem.name);
      const wcls = "o_field_" + ((elem.widget && elem.widget.replace(/[^a-z0-9]/gi, "_")) || (f ? f.type : "char"));
      const wrap = el("div", { class: "o_field_widget " + wcls + (isSel ? " sel" : "") + (elem.invisible === "1" ? " o_invisible_modifier" : "") });
      mark(wrap, path, elem);
      if (elem.name) wrap.setAttribute("data-field", elem.name);
      const lab = el("label", { class: "o_form_label", text: (elem.string || (f && f.string) || elem.name || "字段") });
      if (f && f.required) lab.appendChild(el("span", { class: "o_required", text: " *" }));
      wrap.appendChild(lab);
      wrap.appendChild(oFieldControl(f, elem));
      if (f) wrap.appendChild(el("div", { class: "o_typebadge", text: f.type + (f.relation ? " → " + f.relation : "") }));
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) wrap.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      if (f && f.readonly) wrap.classList.add("o_readonly_modifier");
      return wrap;
    }

    if (elem.kind === "button") {
      return mark(el("button", { class: "btn btn-primary o_inline_btn", text: elem.string || "按钮" }), path, elem);
    }

    if (elem.kind === "separator") {
      return mark(el("div", { class: "o_horizontal_separator", text: elem.string || "" }), path, elem);
    }

    if (elem.kind === "label") {
      // 用 <div> 仿真：孤立 <label> 没有关联控件，会污染设计器页面的表单语义
      const l = el("div", { class: "o_form_label o_standalone o_dsl_label" + (isSel ? " sel" : "") });
      mark(l, path, elem);
      l.appendChild(el("span", { text: elem.string || "标签" }));
      if (elem.for) l.appendChild(el("span", { class: "o_label_meta", text: " for: " + elem.for }));
      if (elem.class) l.appendChild(el("span", { class: "o_label_meta", text: " ." + elem.class }));
      if (elem.invisible === "1" || elem.invisible === 1) l.classList.add("o_invisible_modifier");
      return l;
    }

    if (elem.kind === "customElement") {
      // 自定义元素投影：用 <div> 承载，标签名/契约来自注册表，不把 Odoo tag 当真实 DOM 标签
      const d = viewElementDef(elem.ref);
      const box = mark(el("div", { class: "o_custom_element" + (isSel ? " sel" : "") }), path, elem);
      box.appendChild(el("div", { class: "o_custom_tag",
        text: "⟨" + ((d && d.tag) || elem.ref || "customElement") + "⟩" }));
      const props = elem.props || {};
      const keys = Object.keys(props);
      box.appendChild(el("div", { class: "o_custom_props", text: keys.length
        ? keys.map((k) => k + "=" + props[k]).join("  ")
        : (((d && d.props) || []).length ? "（必填 props 待填）" : "（无 props）") }));
      if (!d) box.appendChild(el("div", { class: "o_custom_warn", text: "未在 viewElements[] 注册" }));
      return box;
    }

    if (elem.kind === "div") {
      // 布局块：class 只作文字标注，不把用户写的 Odoo class 应用到画布 DOM
      const box = el("div", { class: "o_layout_div" + (isSel ? " sel" : "") });
      mark(box, path, elem);
      box.appendChild(el("div", { class: "o_layout_div_tag",
        text: "<div" + (elem.class ? ' class="' + elem.class + '"' : "") + ">" }));
      appendChildren(box, path + ".children", elem.children, modelName, depth);
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) box.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      return box;
    }

    // 结构条出现在切片 patch 元素 / 非 form 根位置时，按通用容器渲染（可点选、可拖入）
    if (elem.kind === "header" || elem.kind === "footer") {
      const box = el("div", { class: "o_struct_box o_struct_" + elem.kind + (isSel ? " sel" : "") });
      mark(box, path, elem);
      box.appendChild(el("div", { class: "o_struct_title", text: "<" + elem.kind + "> 结构条" }));
      const inner = el("div", { class: "o_struct_children" });
      appendChildren(inner, path + ".children", elem.children, modelName, depth);
      box.appendChild(inner);
      return box;
    }

    if (elem.kind === "group" || elem.kind === "page") {
      const box = el("div", { class: "o_group o_inner_group" + (isSel ? " sel" : "") });
      mark(box, path, elem);
      const cols = (elem.col && parseInt(elem.col, 10) > 0) ? parseInt(elem.col, 10) : 2;
      box.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0,1fr))";
      if (elem.string) box.appendChild(el("div", { class: "o_horizontal_separator", text: elem.string }));
      appendChildren(box, path + ".children", elem.children, modelName, depth);
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) box.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      return box;
    }

    if (elem.kind === "notebook") {
      const box = el("div", { class: "o_notebook" + (isSel ? " sel" : "") });
      mark(box, path, elem);
      const pages = elem.pages || [];
      const tabs = el("div", { class: "o_notebook_headers" });
      const activeIdx = notebookActive[path] != null ? notebookActive[path] : 0;
      pages.forEach((p, pi) => {
        const tab = el("div", { class: "o_notebook_tab" + (pi === activeIdx ? " active" : ""), text: p.string || ("页 " + (pi + 1)) });
        tab.addEventListener("click", (e) => { e.stopPropagation(); notebookActive[path] = pi; selectElement(path + ".pages[" + pi + "]"); });
        tabs.appendChild(tab);
      });
      box.appendChild(tabs);
      const pane = el("div", { class: "tab-pane" });
      const page = pages[activeIdx];
      if (page) {
        const pagePath = path + ".pages[" + activeIdx + "]";
        const pbox = mark(el("div", { class: "o_notebook_page" }), pagePath,
                          Object.assign({ kind: "page" }, page));
        appendChildren(pbox, pagePath + ".children", page.children, modelName, depth);
        pane.appendChild(pbox);
      }
      box.appendChild(pane);
      box.addEventListener("click", (e) => { if (e.target === box) selectElement(path); });
      return box;
    }

    // 其它未知 kind
    return mark(el("div", { class: "o_alert" + (isSel ? " sel" : ""), text: "▣ " + elem.kind }), path, elem);
  }

  function renderDropzone(arrPath, modelDef, index) {
    // 切片层画布是基础层镜像：拖拽/加字段必须落到 patch，而非基础层或 extension.elements
    const a = getActive();
    const inPatch = /\.patches\[\d+\]\.elements/.test(arrPath);
    const target = (isSliceSelected() && !inPatch) ? sliceAddTargetPath(a.view, a.binding) : arrPath;
    // 切片层落点被重定向到 patch.elements，原 index 不再对应基础层位置，统一改为末尾追加
    const useIndex = (target === arrPath) ? index : null;
    const dz = el("div", { class: "o_form_dropzone" + (useIndex != null ? " inline" : "") });
    dz.appendChild(el("span", { text: "⤵ 拖拽字段到此，或 " }));
    if (modelDef) {
      const sel = el("select", { onchange: (e) => {
        if (e.target.value) {
          const ok = useIndex != null
            ? insertAtTarget(target, useIndex, { kind: "field", name: e.target.value })
            : appendAtTarget(target, { kind: "field", name: e.target.value });
          if (ok) { e.target.value = ""; rerenderAll(); }
        }
      } });
      sel.appendChild(el("option", { value: "", text: "从模型选择字段 +" }));
      modelDef.fields.forEach((f) => sel.appendChild(el("option", { value: f.name, text: f.name + " (" + f.type + ")" })));
      dz.appendChild(sel);
    } else { dz.appendChild(el("span", { class: "muted", text: "（加载模型定义后可用）" })); }
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.classList.remove("over");
      const name = (e.dataTransfer && e.dataTransfer.getData("text")) || dragField;
      if (name) {
        if (useIndex != null) insertAtTarget(target, useIndex, { kind: "field", name });
        else appendAtTarget(target, { kind: "field", name });
        rerenderAll();
      }
    });
    return dz;
  }

  // 在容器子列表里「按位置」穿插停靠区：每个子元素前有一个（插入到其下标），
  // 末尾再补一个（插入到末尾）。这样每个元素都有可接收新组件的停靠区，且支持
  // 精确插到指定兄弟位置（而非只能追加到容器末尾）。
  function appendChildren(box, arrPath, children, modelName, depth) {
    const modelDef = getModel(modelName);
    (children || []).forEach((c, ci) => {
      box.appendChild(renderDropzone(arrPath, modelDef, ci));
      box.appendChild(canvasElem(c, arrPath + "[" + ci + "]", modelName, depth + 1));
    });
    box.appendChild(renderDropzone(arrPath, modelDef, (children || []).length));
  }

  function selectElement(path, domXpath) {
    // 取目标模式：把点中的画布元素写成该 patch 的 xpath，闭环「所见即所得」
    if (pickXpathFor && path) {
      const xp = domXpath || xpathForElement(getPath(state, path));
      if (xp && !UNSTABLE_XPATH.test(xp)) {
        const v = (state.bindings[activeB].views || [])[pickXpathFor.viewIdx];
        const p = v && (v.patches || [])[pickXpathFor.patchIdx];
        if (p) p.xpath = xp;
        pickXpathFor = null; pickHint = ""; selectedPath = null;
        rerenderAll();
        return;
      }
      // 无 name 的结构容器：不生成不稳定的 xpath，明确告知替代做法
      pickHint = "该元素没有 name，不能生成唯一定位。请点选带 name 的字段，或用 //field[@name=\"…\"] 手写锚点。";
      renderCanvasBar(); renderRight();
      return;
    }
    selectedPath = path; renderCanvas(); renderRight();
  }

  // ════════════ 右栏：检查器 + 输出 ════════════
  function renderRight() {
    const right = $("#right"); right.innerHTML = "";
    right.appendChild(renderInspector());
    right.appendChild(renderOutputCard());
    renderOutput();   // 卡片已入 document，再刷新输出与校验状态
    associateLabels(right);
  }

  function renderInspector() {
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "insp-title" }, [el("span", { text: "检查器（显示控制）" })]));
    if (!selectedPath) {
      const a0 = getActive();
      card.appendChild(el("div", { class: "muted", text: isExtension(a0.view)
        ? "当前在切片层：画布显示基础层 + 切片叠加预览。用下方「切片修改 (patches)」编排修改，或点画布元素把它设为目标。"
        : "在画布上点选一个元素以编辑其属性；或在左栏字段面板点选字段，落入" + (isContainerSelected() ? "选中容器" : "根") + "。" }));
      const a = getActive();
      if (a.view) {
        card.appendChild(el("label", { text: "当前视图 id" }));
        card.appendChild(el("input", { value: a.view.id || "", oninput: (e) => { a.view.id = e.target.value; renderOutput(); } }));
        card.appendChild(el("label", { text: "viewType（binding 级，可选注册类型）" }));
        const vts = el("select", { onchange: (e) => { a.binding.viewType = e.target.value; rerenderAll(); } });
        VIEW_TYPES.concat(customTypeIds()).forEach((t) => vts.appendChild(el("option", {
          value: t, text: t + (customTypeIds().indexOf(t) >= 0 ? "（自定义）" : ""),
          selected: a.binding.viewType === t ? "selected" : null })));
        card.appendChild(vts);
        // mode 由图层面板统一管理：直接切换会产出 primary+patches / extension+elements 的非法组合
        card.appendChild(el("div", { class: "muted", text: "mode: " + (a.view.mode || "primary") + "（由左栏『图层 / Layers』管理：＋切片 / 调序 / 删除）" }));
        if (isExtension(a.view)) {
          card.appendChild(el("label", { text: "inherit（前序层 id 或外部基视图 xml_id）" }));
          card.appendChild(el("input", { value: a.view.inherit || "", onchange: (e) => {
            a.view.inherit = e.target.value.trim(); normalizeLayerStack(a.binding); rerenderAll();
          } }));
          card.appendChild(renderPatchEditor(a.view));
        }
      }
      return card;
    }
    const elem = getPath(state, selectedPath);
    const a = getActive();
    const inPatch = /\.patches\[\d+\]\.elements/.test(selectedPath);
    if (isExtension(a.view) && !inPatch) {
      // 基础层镜像只读：避免用户以为在编辑切片、实际改了基础层
      const e2 = elem && elem.kind ? elem
        : (/\.pages\[\d+\]$/.test(selectedPath) ? Object.assign({ kind: "page" }, elem || {}) : (elem || {}));
      const xp = xpathForElement(e2);
      card.appendChild(el("div", { class: "insp-title" }, [
        el("span", { text: "▣ " + (e2.kind || "元素") }),
        el("span", { class: "muted", text: "基础层镜像（只读）" }),
      ]));
      card.appendChild(el("div", { class: "muted", text: "切片层的画布是基础层镜像，元素不能在这里直接编辑。请把它作为修改目标，或点下方 patch 的 chip 编辑插入的元素。" }));
      if (xp && !UNSTABLE_XPATH.test(xp)) {
        card.appendChild(el("div", { class: "typebadge", text: xp }));
        card.appendChild(el("button", { class: "sm primary", text: "＋ 以此元素为目标添加修改", onclick: () => {
          const patches = a.view.patches || (a.view.patches = []);
          patches.push({ xpath: xp, position: "after" });
          selectedPath = null; rerenderAll();
        } }));
      } else {
        card.appendChild(el("div", { class: "typebadge warn", text:
          "该元素没有 name，不能生成唯一定位（string 可重复）。请选其中的字段作为目标，或手写基于 @name 的 xpath。" }));
      }
      return card;
    }
    const pm = selectedPath.match(/\.pages\[(\d+)\]$/);
    if (pm) { card.appendChild(renderPageInspector(selectedPath)); return card; }
    const def = KIND_DEFS[elem.kind] || {};
    card.appendChild(el("div", { class: "insp-title" }, [el("span", { text: "▣ " + elem.kind }), el("span", { class: "muted", text: selectedPath })]));
    if (elem.kind === "field") { card.appendChild(renderFieldEditor(elem, selectedPath, a.modelName)); }
    else if (elem.kind === "customElement") { card.appendChild(renderCustomElementEditor(elem)); }
    else {
      card.appendChild(renderGenericFields(elem, selectedPath, def));
      if (elem.kind === "label") card.appendChild(el("div", { class: "muted", text:
        "独立标签：for 指向同表单内的字段名（仅用于显示关联，不是 xpath 定位键）；class / groups / invisible / colspan / nolabel 都会写入 arch。" }));
      if (def.children) {
        if (elem.kind === "div") card.appendChild(el("div", { class: "muted", text:
          "布局块 <div>：class / groups / invisible / colspan 原样写入 arch；可嵌套字段、label、group 等，也可作为切片 patch 的注入容器。" }));
        if (elem.kind === "notebook") {
          card.appendChild(el("button", { class: "sm", text: "+ 页", onclick: () => { const pages = elem.pages || (elem.pages = []); pages.push({ string: "页 " + (pages.length + 1), children: [] }); rerenderAll(); } }));
        }
        if (elem.kind === "header" || elem.kind === "footer") {
          card.appendChild(el("div", { class: "muted", text: elem.kind === "header"
            ? "顶部条：必须是视图根 elements 的第 1 项（arch 中 <header> 位于 <form> 最前），限 form/list；位置固定，不可调序。"
            : "底部条：必须是视图根 elements 的最后一项（arch 中 <footer> 位于 <form> 末尾），仅 form；位置固定，不可调序。" }));
        }
        card.appendChild(el("div", { class: "muted", text: "这是一个容器，可在画布拖入字段，或点选「+ 字段」。" }));
      }
    }
    // move / delete（结构条位置由 arch 顺序约束固定，禁止调序）
    const isStructure = elem.kind === "header" || elem.kind === "footer";
    const m = selectedPath.match(/(.*)\[(\d+)\]$/);
    if (m) {
      const arrPath = m[1], idx = +m[2];
      const row = el("div", { class: "row", style: "margin-top:8px" });
      if (!isStructure) {
        // 普通元素不能越过首位的 header 或末尾的 footer（结构条位置固定）
        row.appendChild(el("button", { class: "sm", text: "▲ 上移", onclick: () => {
          const arr = getPath(state, arrPath);
          if (idx > 0 && !(arr[idx - 1] && STRUCTURE_KINDS.indexOf(arr[idx - 1].kind) >= 0)) {
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; rerenderAll();
          }
        } }));
        row.appendChild(el("button", { class: "sm", text: "▼ 下移", onclick: () => {
          const arr = getPath(state, arrPath);
          if (idx < arr.length - 1 && !(arr[idx + 1] && STRUCTURE_KINDS.indexOf(arr[idx + 1].kind) >= 0)) {
            [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]]; rerenderAll();
          }
        } }));
      }
      row.appendChild(el("button", { class: "sm danger", text: "删除", onclick: () => { const arr = getPath(state, arrPath); if (Array.isArray(arr)) { arr.splice(idx, 1); selectedPath = null; rerenderAll(); } } }));
      card.appendChild(row);
    }
    return card;
  }

  function renderGenericFields(elem, path, def) {
    const frag = document.createDocumentFragment();
    const NUMERIC = new Set(["col", "colspan", "priority", "sequence", "limit"]);
    const BOOLEAN = new Set(["nolabel"]);   // schema 要求 boolean，不能用文本输入写 "True"/"1"
    const fields = [...(def.req || []), ...(def.opt || [])];
    fields.forEach((f) => {
      const val = elem[f] != null ? elem[f] : "";
      frag.appendChild(el("label", { text: f + (def.req && def.req.includes(f) ? " *" : "") }));
      if (BOOLEAN.has(f)) {
        const sel = el("select", { onchange: (e) => {
          const v = e.target.value;
          if (v === "") delete elem[f]; else elem[f] = (v === "1");
          updateCanvas();
        }});
        [["", "（未设置）"], ["1", "1 / true"], ["0", "0 / false"]].forEach(([v, t]) =>
          sel.appendChild(el("option", { value: v, text: t,
            selected: (elem[f] === undefined ? v === "" : (elem[f] ? v === "1" : v === "0")) ? "selected" : null })));
        frag.appendChild(sel);
      } else if (NUMERIC.has(f)) {
        frag.appendChild(el("input", { type: "number", min: "1", value: val, oninput: (e) => { const v = e.target.value.trim(); if (v === "") delete elem[f]; else elem[f] = parseInt(v, 10) || 1; updateCanvas(); } }));
      } else {
        frag.appendChild(el("input", { value: val, oninput: (e) => { setPath(state, path + "." + f, e.target.value); updateCanvas(); } }));
      }
    });
    return frag;
  }

  function renderCustomElementEditor(elem) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el("label", { text: "ref（自定义元素）*" }));
    const sel = el("select", { onchange: (e) => {
      elem.ref = e.target.value;
      const d = viewElementDef(elem.ref);
      elem.props = {};
      ((d && d.props) || []).forEach((p) => {
        if (p && p.name && p.default !== undefined) elem.props[p.name] = p.default;
      });
      rerenderAll();
    } });
    (state.viewElements || []).forEach((d) => sel.appendChild(el("option", {
      value: d.id, text: d.id + " → <" + (d.tag || d.id) + ">",
      selected: d.id === elem.ref ? "selected" : null })));
    frag.appendChild(sel);
    const d = viewElementDef(elem.ref);
    if (!d) {
      frag.appendChild(el("div", { class: "typebadge warn", text: "ref 未在 viewElements[] 注册，请先在左栏声明" }));
      return frag;
    }
    frag.appendChild(el("div", { class: "muted", text: "props 契约（值按字符串写入 arch 标签属性）" }));
    (d.props || []).forEach((p) => {
      if (!p || !p.name) return;
      frag.appendChild(el("label", { text: p.name + (p.required ? " *" : "") }));
      frag.appendChild(el("input", {
        value: (elem.props && elem.props[p.name]) != null ? elem.props[p.name] : "",
        oninput: (e) => {
          if (!elem.props) elem.props = {};
          if (e.target.value) elem.props[p.name] = e.target.value;
          else delete elem.props[p.name];
          renderOutput();
        },
      }));
    });
    if (!(d.props || []).length) frag.appendChild(el("div", { class: "muted", text:
      "该元素未声明 props 契约，可在注册项里补充必需/可选 props。" }));
    frag.appendChild(el("div", { class: "muted", text:
      "tag 与 props 契约由左栏『自定义注册』维护；画布只是投影，权威结果请用 python3 -m oview.pipeline。" }));
    return frag;
  }

  function renderPageInspector(selectedPath) {
    const frag = document.createDocumentFragment();
    const m = selectedPath.match(/(.*)\.pages\[(\d+)\]$/);
    if (!m) { frag.appendChild(el("div", { class: "muted", text: "无法解析页路径" })); return frag; }
    const pagesPath = m[1] + ".pages";
    const pi = +m[2];
    const pages = getPath(state, pagesPath);
    const page = pages ? pages[pi] : null;
    if (!page) { frag.appendChild(el("div", { class: "muted", text: "页不存在" })); return frag; }
    frag.appendChild(el("div", { class: "insp-title" }, [el("span", { text: "▣ page" }), el("span", { class: "muted", text: selectedPath })]));
    frag.appendChild(el("label", { text: "string（页标签）" }));
    frag.appendChild(el("input", { value: page.string || "", placeholder: "页签标题", oninput: (e) => { page.string = e.target.value; rerenderAll(); } }));
    frag.appendChild(el("div", { class: "muted", text: "本页含 " + (page.children ? page.children.length : 0) + " 个元素。可在画布拖入字段，或点选「+ 字段」。" }));
    const row = el("div", { class: "row", style: "margin-top:8px" });
    row.appendChild(el("button", { class: "sm danger", text: "删除本页", onclick: () => { pages.splice(pi, 1); selectedPath = null; rerenderAll(); } }));
    frag.appendChild(row);
    return frag;
  }

  // ════════════ 图层 / 切片（Layers / Slices）═══════════
  // 概念：ViewTypeBinding.views[] 即有序「继承层栈」（规范 §4.1）。
  //   层 0 = 基础层（primary）；其余 = 切片层（extension），inherit 前序层或
  //   含 '.' 的外部基视图，通过 patches（xpath/position）做增量修改。
  //   Odoo 运行时沿 inherit 链、按 priority 升序合并成有效视图（effective view）。
  function layerBaseView(binding) {
    const arr = (binding && binding.views) || [];
    const i = arr.findIndex((v) => (v.mode || "primary") !== "extension");
    if (i >= 0) return { view: arr[i], idx: i };
    if (arr.length) return { view: arr[0], idx: 0 };
    return null;
  }
  // 唯一切片 id：按层栈长度递增，删除中间层后重建不会撞号（曾导致 VIEW_ID_DUPLICATE）
  function nextSliceId(b) {
    const used = {};
    (b.views || []).forEach((v) => { used[v.id] = true; });
    let n = (b.views || []).length;
    while (used["slice_" + n]) n++;
    return "slice_" + n;
  }
  // 层栈规范化：priority 单调（16 + 层索引，对齐 Odoo 默认 16）；
  // inherit 必须指向前序层，外部基视图（含 '.'）视为链根，不重指。
  function normalizeLayerStack(b) {
    const vs = b.views || [];
    vs.forEach((v, k) => { v.priority = 16 + k; });
    for (let k = 1; k < vs.length; k++) {
      const v = vs[k];
      if (!isExtension(v) || isExternalInherit(v.inherit)) continue;
      const allowed = vs.slice(0, k).map((x) => x.id);
      if (!v.inherit || allowed.indexOf(v.inherit) < 0) v.inherit = vs[k - 1].id;
    }
  }
  // 切片层添加元素的落点：最后一条非 attributes 的 patch.elements。
  // 绝不能写进 extension.elements —— 生成器只消费 patches，会静默丢数据。
  function sliceAddTargetPath(view, binding) {
    const patches = view.patches || (view.patches = []);
    let idx = -1;
    for (let i = patches.length - 1; i >= 0; i--) {
      if ((patches[i].position || "after") !== "attributes") { idx = i; break; }
    }
    if (idx < 0) {
      const base = layerBaseView(binding);
      const fname = base ? firstFieldName(base.view) : "name";
      patches.push({ xpath: '//field[@name="' + fname + '"]', position: "after", elements: [] });
      idx = patches.length - 1;
    }
    if (!patches[idx].elements) patches[idx].elements = [];
    return "bindings[" + activeB + "].views[" + activeV + "].patches[" + idx + "].elements";
  }
  function addSlice(b) {
    const base = layerBaseView(b);
    const id = nextSliceId(b);
    if (!b.views) b.views = [];
    b.views.push({ id: id, name: "切片 " + id.replace("slice_", ""), mode: "extension",
                   inherit: base ? base.view.id : undefined, patches: [] });
    normalizeLayerStack(b);
    activeV = b.views.length - 1; selectedPath = null; pickXpathFor = null; rerenderAll();
  }
  function moveLayer(b, i, dir) {
    const j = i + dir;
    if (!b.views || j < 0 || j >= b.views.length) return;
    const moving = b.views[i];
    if (!isExtension(moving) && dir > 0) return;      // 基础层不可下移
    if (j === 0 && isExtension(moving)) return;       // 切片不可上移到层 0
    const t = b.views[i]; b.views[i] = b.views[j]; b.views[j] = t;
    normalizeLayerStack(b);                            // 调序即重算合并顺序 + 修复 inherit
    if (activeV === i) activeV = j; else if (activeV === j) activeV = i;
    selectedPath = null; pickXpathFor = null;
    rerenderAll();
  }
  function firstFieldName(view) {
    const stack = (view && view.elements) ? [].concat(view.elements) : [];
    while (stack.length) {
      const e = stack.shift();
      if (!e) continue;
      if (e.kind === "field" && e.name) return e.name;
      if (e.children) stack.push.apply(stack, e.children);
      if (e.pages) e.pages.forEach((pg) => { if (pg.children) stack.push.apply(stack, pg.children); });
    }
    return "name";
  }
  function xpathFieldName(xpath) {
    if (!xpath) return null;
    const m = String(xpath).match(/field\[@name\s*=\s*['"]([^'"]+)['"]\]/);
    return m ? m[1] : null;
  }
  function sliceBadgeText(p, tname) {
    const pos = p.position || "after";
    const label = tname ? "“" + tname + "”" : "(目标)";
    let txt = "在 " + label + " " + posTextShort(pos);
    if (pos !== "attributes") {
      const els = p.elements || [];
      if (els.length) txt += "：" + els.map(describeElem).join(", ");
    } else {
      const attrs = p.attrs || [];
      if (attrs.length) txt += "：" + attrs.map((a) => a.name + "=" + (a.value != null ? a.value : "")).join(", ");
    }
    return txt;
  }
  // 预览要叠加哪些切片：chain = 到当前切片为止；all = 全部（≈ 有效视图）
  function previewSlices(b) {
    const vs = b.views || [];
    const upto = previewScope === "all" ? vs.length : activeV + 1;
    const out = [];
    for (let i = 0; i < Math.min(upto, vs.length); i++) {
      if (isExtension(vs[i])) out.push({ view: vs[i], idx: i });
    }
    return out;
  }
  // 用画布节点的 data-xpath 精确匹配任意元素目标；field 保留旧的 data-field 兜底
  function findSliceTargets(root, xpath) {
    if (!xpath) return [];
    const fname = xpathFieldName(xpath);
    const out = [];
    (function walk(n) {
      if (!n || n.nodeType !== 1) return;
      const dx = n.getAttribute && n.getAttribute("data-xpath");
      const hit = (dx && dx === xpath) ||
        (fname && n.classList && n.classList.contains("o_field_widget") &&
         n.getAttribute("data-field") === fname);
      if (hit) { out.push(n); return; }   // 命中即停，避免嵌套重复标注
      const ch = n.children || [];
      for (let i = 0; i < ch.length; i++) walk(ch[i]);
    })(root);
    return out;
  }
  // 把 attributes 型修改真正体现在画布上（不只是贴徽标）
  function applyAttrPreview(tn, a) {
    if (!a || !a.name) return;
    const val = a.value != null ? String(a.value) : "";
    const on = val === "1" || val === "true" || val === "True";
    const lab = tn.querySelector ? tn.querySelector(".o_form_label") : null;
    if (a.name === "invisible" && on) tn.classList.add("o_invisible_modifier");
    else if (a.name === "readonly" && on) tn.classList.add("o_readonly_modifier");
    else if (a.name === "required" && on && lab && !lab.querySelector(".o_required"))
      lab.appendChild(el("span", { class: "o_required", text: " *" }));
    else if (a.name === "string" && lab) lab.textContent = val;
  }
  function applySlicePreview(root, slice, opt) {
    const o = opt || {};
    const label = o.label || slice.name || slice.id || "切片";
    (slice.patches || []).forEach((p, pi) => {
      const pos = p.position || "after";
      const targets = findSliceTargets(root, p.xpath);
      if (!targets.length) {
        root.appendChild(el("div", { class: "o_slice_note", text:
          "[" + label + "] 修改 #" + (pi + 1) + "：当前基础层未命中目标 " + (p.xpath || "（无 xpath）") }));
        return;
      }
      targets.forEach((tn) => {
        tn.classList.add("o_slice_target");
        if (!o.current) tn.classList.add("o_slice_inherited");
        const badge = el("div", {
          class: "o_slice_badge" + (o.current ? " current" : " inherited"),
          text: (o.current ? "切片 ▸ " : "继承切片 ▸ ") + sliceBadgeText(p, targetName(p.xpath)),
        });
        const pn = tn.parentNode;
        if (pn && pn.insertBefore) pn.insertBefore(badge, tn.nextSibling || null);
        else if (pn) pn.appendChild(badge);
        if (pos === "attributes") {
          (p.attrs || []).forEach((a) => applyAttrPreview(tn, a));
        } else if (pos === "replace") {
          tn.classList.add("o_slice_replaced");
        } else if (p.elements && p.elements.length) {
          const box = el("div", { class: "o_slice_insert", text:
            "[" + label + "] " + posTextShort(pos) + "：" + p.elements.map(describeElem).join("、") });
          if (pn) pn.insertBefore(box, pos === "before" ? tn : (badge.nextSibling || null));
        }
      });
    });
  }
  function renderLayers() {
    const card = el("div", { class: "card" });
    const a = getActive();
    const b = a.binding;
    card.appendChild(el("h2", { text: "图层 / Layers（继承栈）" }));
    card.appendChild(el("p", { class: "muted", text: "层 0 = 基础层(primary)；其余 = 切片层(extension)，inherit 前序层或含 . 的外部基视图。调序即调整 priority/合并顺序，Odoo 运行时沿 inherit 链合并为有效视图。" }));
    const list = el("div", { class: "layers" });
    (b.views || []).forEach((v, vi) => {
      const isBase = (v.mode || "primary") !== "extension";
      const row = el("div", { class: "layer" + (vi === activeV ? " active" : "") });
      // inherit 是输入框，会覆盖行的大部分区域；因此把「切层」明确绑定到 head，
      // 行内其余空白区也可切换，但输入框与操作按钮除外。
      const switchLayer = (ev) => {
        if (ev) ev.stopPropagation();
        activeV = vi; selectedPath = null; pickXpathFor = null; pickHint = ""; rerenderAll();
      };
      row.addEventListener("click", (e) => {
        if (e.target.closest && e.target.closest(".layer-ctl, .layer-inherit")) return;
        switchLayer();
      });
      // 原生 button 自带键盘操作 / 焦点 / role，避免 <div role="button"> 或手写 Enter/Space handler
      const head = el("button", { type: "button", class: "layer-head", "data-layer-idx": vi });
      head.addEventListener("click", switchLayer);
      head.appendChild(el("span", { class: "layer-name", text: v.name || v.id }));
      head.appendChild(el("span", { class: "layer-badge " + (isBase ? "base" : "slice"), text: isBase ? "基础" : "切片" }));
      head.appendChild(el("span", { class: "layer-meta", text: "层 " + vi + (v.priority != null ? " · p" + v.priority : "") }));
      row.appendChild(head);
      if (!isBase) {
        // 可编辑 inherit：既可填本 binding 前序层 id，也可填含 . 的跨模块基视图 xml_id
        const dlId = "inherit-opts-" + activeB + "-" + vi;
        const dl = el("datalist", { id: dlId });
        (b.views || []).slice(0, vi).forEach((o) =>
          dl.appendChild(el("option", { value: o.id, text: o.id + "（前序层）" })));
        row.appendChild(el("input", {
          class: "layer-inherit", list: dlId, value: v.inherit || "",
          "aria-label": "inherit 目标：本 binding 前序层 id，或含点号的跨模块基视图 xml_id",
          placeholder: "前序层 id 或外部 xml_id",
          title: "inherit：本 binding 前序层 id，或含 . 的跨模块基视图 xml_id（层栈根）",
          onchange: (e) => { v.inherit = e.target.value.trim(); normalizeLayerStack(b); rerenderAll(); },
        }));
        row.appendChild(dl);
      }
      const ctl = el("div", { class: "layer-ctl" });
      ctl.appendChild(el("button", { class: "sm", text: "▲", title: "上移（层 0 恒为基础层）", onclick: (e) => { e.stopPropagation(); moveLayer(b, vi, -1); } }));
      ctl.appendChild(el("button", { class: "sm", text: "▼", title: "下移（调整合并顺序）", onclick: (e) => { e.stopPropagation(); moveLayer(b, vi, +1); } }));
      ctl.appendChild(el("button", { class: "sm danger", text: "✕", title: isBase ? "基础层不可删除" : "删除切片层", onclick: (e) => {
        e.stopPropagation();
        if (isBase) { showNotice("无法删除基础层", "层栈必须保留一个 primary 基视图。要清空层栈，请先删除所有切片层。"); return; }
        b.views.splice(vi, 1);
        normalizeLayerStack(b);
        if (activeV >= b.views.length) activeV = Math.max(0, b.views.length - 1);
        selectedPath = null; pickXpathFor = null;
        rerenderAll();
      } }));
      row.appendChild(ctl);
      list.appendChild(row);
    });
    card.appendChild(list);
    card.appendChild(el("button", { class: "sm", text: "＋ 切片（在基础层上修改）", onclick: () => { addSlice(b); } }));
    return card;
  }
  function renderPatchEditor(view) {
    const frag = document.createDocumentFragment();
    const a = getActive();
    frag.appendChild(el("div", { class: "insp-title" }, [
      el("span", { text: "切片修改 (patches)" }),
      el("span", { class: "muted", text: "对父 arch 的 xpath/position 增量修改" }),
    ]));
    const patches = view.patches || (view.patches = []);
    if (!patches.length) frag.appendChild(el("div", { class: "muted", text: "尚无修改。点「＋ 添加修改」，然后用手输、🎯 从画布选目标，或在画布上点选元素一键生成。" }));
    const base = layerBaseView(a.binding);
    const modelDef = getModel(a.binding.model);
    const baseModelDef = base ? getModel(base.view.model || a.binding.model) : modelDef;
    patches.forEach((p, pi) => {
      const sub = el("div", { class: "patch" });
      sub.appendChild(el("div", { class: "insp-title" }, [
        el("span", { text: "修改 #" + (pi + 1) }),
        el("span", { class: "muted", text: "层 " + a.v + " · " + (p.position || "after") }),
      ]));
      const picking = pickXpathFor && pickXpathFor.viewIdx === a.v && pickXpathFor.patchIdx === pi;
      sub.appendChild(el("button", {
        class: "sm" + (picking ? " primary" : ""),
        text: picking ? "🎯 选取中…（点带 name 的元素）" : "🎯 从画布选目标（仅带 name 的元素）",
        onclick: () => { pickXpathFor = picking ? null : { viewIdx: a.v, patchIdx: pi }; pickHint = ""; selectedPath = null; rerenderAll(); },
      }));
      sub.appendChild(el("label", { text: "目标 xpath（也可填字段名自动补全）" }));
      const tval = xpathFieldName(p.xpath) || p.xpath || "";
      sub.appendChild(el("input", {
        value: tval, placeholder: "如 amount_total，或 //field[@name=\"amount_total\"]（禁用 @string/@for）",
        list: baseModelDef ? ensureFieldDatalist(baseModelDef) : undefined,
        oninput: (e) => {
          const v = e.target.value.trim();
          p.xpath = (v.indexOf("//") >= 0 || v.indexOf("@") >= 0) ? v
                  : (v ? '//field[@name="' + v + '"]' : "");
          updateCanvas();
        },
      }));
      sub.appendChild(el("label", { text: "position" }));
      const pos = el("select", { onchange: (e) => {
        const nw = e.target.value;
        p.position = nw;
        // 切换 position 时同步迁移载荷，保证产物始终满足契约（attributes↔attrs 互斥）
        if (nw === "attributes") {
          delete p.elements;
          if (!p.attrs || !p.attrs.length) p.attrs = [{ name: "invisible", value: "1" }];
        } else {
          delete p.attrs;
          if (p.elements && !p.elements.length) delete p.elements;
        }
        selectedPath = null; pickXpathFor = null; rerenderAll();
      } });
      PATCH_POSITIONS.forEach((v) => pos.appendChild(el("option", {
        value: v, text: v, selected: (p.position || "after") === v ? "selected" : null,
      })));
      sub.appendChild(pos);
      if ((p.position || "after") !== "attributes") {
        sub.appendChild(el("label", { text: "插入的元素（点 chip 编辑属性，× 删除）" }));
        const pe = p.elements || [];
        const pl = el("div", { class: "patch-elems" });
        pe.forEach((elc, ei) => {
          const ePath = "bindings[" + activeB + "].views[" + activeV + "].patches[" + pi + "].elements[" + ei + "]";
          const chip = el("span", { class: "chip sm" + (selectedPath === ePath ? " active" : ""),
            text: describeElem(elc), title: "点击在检查器中编辑该插入元素",
            onclick: () => { selectedPath = ePath; renderCanvas(); renderRight(); } });
          chip.appendChild(el("span", { class: "x", text: " ×", onclick: (ev) => {
            ev.stopPropagation(); pe.splice(ei, 1);
            if (selectedPath === ePath) selectedPath = null;
            rerenderAll();
          } }));
          pl.appendChild(chip);
        });
        sub.appendChild(pl);
        if (modelDef) {
          const sel = el("select", { onchange: (e) => {
            if (!e.target.value) return;
            const f = fieldOf(modelDef, e.target.value);
            (p.elements || (p.elements = [])).push({ kind: "field", name: e.target.value, string: f ? f.string : undefined });
            e.target.value = ""; rerenderAll();
          } });
          sel.appendChild(el("option", { value: "", text: "+ 字段" }));
          modelDef.fields.forEach((f) => sel.appendChild(el("option", { value: f.name, text: f.name + " (" + f.type + ")" })));
          sub.appendChild(sel);
        }
        const kinds = ["group", "notebook", "page", "button", "separator", "label", "filter", "if", "foreach", "raw"];
        const ksel = el("select", { onchange: (e) => {
          const k = e.target.value; if (!k) return;
          (p.elements || (p.elements = [])).push(defaultPatchElement(k, modelDef));
          e.target.value = ""; rerenderAll();
        } });
        ksel.appendChild(el("option", { value: "", text: "+ 其它元素" }));
        kinds.forEach((k) => ksel.appendChild(el("option", { value: k, text: k })));
        sub.appendChild(ksel);
      } else {
        sub.appendChild(el("label", { text: "属性修改 (attrs)" }));
        const attrs = p.attrs || (p.attrs = []);
        attrs.forEach((at, ai) => {
          const r = el("div", { class: "row" });
          r.appendChild(el("input", { "aria-label": "属性名", value: at.name || "", placeholder: "属性名", oninput: (e) => { at.name = e.target.value; updateCanvas(); } }));
          r.appendChild(el("input", { "aria-label": "属性值", value: at.value != null ? at.value : "", placeholder: "值", oninput: (e) => { at.value = e.target.value; updateCanvas(); } }));
          r.appendChild(el("button", { class: "sm danger", text: "×", onclick: () => { attrs.splice(ai, 1); rerenderAll(); } }));
          sub.appendChild(r);
        });
        sub.appendChild(el("button", { class: "sm", text: "+ 属性", onclick: () => { attrs.push({ name: "", value: "" }); rerenderAll(); } }));
      }
      sub.appendChild(el("button", { class: "sm danger", text: "删除此修改", onclick: () => {
        patches.splice(pi, 1); pickXpathFor = null; selectedPath = null; rerenderAll();
      } }));
      frag.appendChild(sub);
    });
    frag.appendChild(el("button", { class: "sm", text: "＋ 添加修改 (patch)", onclick: () => {
      const base = layerBaseView(a.binding);
      const fname = base ? firstFieldName(base.view) : "name";
      patches.push({ xpath: '//field[@name="' + fname + '"]', position: "after" });
      pickXpathFor = null; rerenderAll();
    } }));
    return frag;
  }

  function renderFieldEditor(elem, path, modelName) {
    const frag = document.createDocumentFragment();
    const modelDef = getModel(modelName);
    frag.appendChild(el("label", { text: "name（字段）*" }));
    if (modelDef) {
      const listId = ensureFieldDatalist(modelDef);
      const inp = el("input", { list: listId, value: elem.name || "", placeholder: "从模型字段选择或手输",
        oninput: (e) => { elem.name = e.target.value; updateCanvas(); },
        onchange: (e) => { onFieldChosen(elem, modelDef); rerenderAll(); } });
      frag.appendChild(inp);
      const f = fieldOf(modelDef, elem.name);
      if (f) {
        const meta = [f.type]; if (f.relation) meta.push("→ " + f.relation); if (f.required) meta.push("必填"); if (f.readonly) meta.push("只读");
        frag.appendChild(el("div", { class: "typebadge", text: meta.join(" · ") }));
      } else if (elem.name) frag.appendChild(el("div", { class: "typebadge warn", text: "⚠ 字段不在模型 " + modelName + " 中" }));
    } else {
      frag.appendChild(el("input", { value: elem.name || "", oninput: (e) => { elem.name = e.target.value; updateCanvas(); } }));
    }
    frag.appendChild(el("label", { text: "string（显示标签）" }));
    frag.appendChild(el("input", { value: elem.string || "", placeholder: "留空则沿用模型字段名", oninput: (e) => { elem.string = e.target.value; updateCanvas(); } }));
    frag.appendChild(el("label", { text: "widget（显示控件）" }));
    if (modelDef && fieldOf(modelDef, elem.name)) {
      const f = fieldOf(modelDef, elem.name); const sug = widgetSuggestions(f.type);
      const wsel = el("select", { onchange: (e) => { elem.widget = e.target.value || undefined; if (!e.target.value) delete elem.widget; rerenderAll(); } });
      wsel.appendChild(el("option", { value: "", text: "（默认）" }));
      sug.forEach((w) => wsel.appendChild(el("option", { value: w, text: w, selected: elem.widget === w ? "selected" : null })));
      wsel.appendChild(el("option", { value: "__custom", text: "自定义…" }));
      if (elem.widget && !sug.includes(elem.widget)) wsel.value = "__custom";
      frag.appendChild(wsel);
      if (!sug.includes(elem.widget) && elem.widget) frag.appendChild(el("input", { value: elem.widget, placeholder: "自定义 widget", oninput: (e) => { elem.widget = e.target.value; updateCanvas(); } }));
    } else {
      frag.appendChild(el("input", { value: elem.widget || "", placeholder: "如 email / monetary / many2many_tags", oninput: (e) => { elem.widget = e.target.value; updateCanvas(); } }));
    }
    const ctrl = el("div", { class: "checkrow" });
    [["invisible", "隐藏"], ["readonly", "只读"], ["required", "必填"]].forEach(([key, label]) => {
      const lab = document.createElement("label"); lab.className = "chk";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!(elem[key] === "1" || elem[key] === true);
      cb.addEventListener("change", () => { if (cb.checked) elem[key] = "1"; else delete elem[key]; updateCanvas(); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(label)); ctrl.appendChild(lab);
    });
    frag.appendChild(ctrl);
    frag.appendChild(el("label", { text: "colspan（跨列数，默认 1）" }));
    frag.appendChild(el("input", { type: "number", min: "1", value: elem.colspan || "", placeholder: "1", oninput: (e) => { const v = e.target.value.trim(); if (v === "") delete elem.colspan; else elem.colspan = parseInt(v, 10) || 1; updateCanvas(); } }));
    ["domain", "context", "groups"].forEach((k) => {
      frag.appendChild(el("label", { text: k }));
      frag.appendChild(el("input", { value: elem[k] || "", oninput: (e) => { elem[k] = e.target.value; updateCanvas(); } }));
    });
    const extraTxt = elem.extra && typeof elem.extra === "object" ? JSON.stringify(elem.extra) : "";
    frag.appendChild(el("label", { text: "其它字段 (JSON 对象，可选)" }));
    const ta = el("textarea", { placeholder: '{"digits":[2,3]}', oninput: (e) => { const raw = e.target.value.trim(); if (!raw) { delete elem.extra; updateCanvas(); return; } try { elem.extra = JSON.parse(raw); updateCanvas(); } catch (_) {} } });
    ta.value = extraTxt; frag.appendChild(ta);
    return frag;
  }

  // ── 输出卡片 ──
  function renderOutputCard() {
    const card = el("div", { class: "card" });
    const tb = el("div", { class: "toolbar" });
    tb.appendChild(el("strong", { text: "DSL 输出" }));
    tb.appendChild(el("span", { class: "grow" }));
    const sf = el("input", { type: "file", id: "schemaFile", accept: ".json", "aria-label": "加载 schema JSON 文件做权威校验", title: "加载实时 schema 做权威校验（可选）", style: "width:auto;font-size:12px" });
    sf.addEventListener("change", (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { liveSchema = JSON.parse(r.result); renderOutput(); } catch (err) { showNotice("schema 解析失败", err.message); } }; r.readAsText(f); });
    tb.appendChild(sf);
    const dlBtn = el("button", { class: "sm", id: "dlBtn", text: "下载 .yaml" });
    const copyBtn = el("button", { class: "sm primary", id: "copyBtn", text: "复制" });
    tb.appendChild(dlBtn);
    tb.appendChild(copyBtn);
    card.appendChild(tb);
    card.appendChild(el("div", { id: "status", class: "status warn", text: "尚未校验" }));
    card.appendChild(el("pre", { id: "yamlOut" }));
    const det = el("details");
    det.appendChild(el("summary", { text: "近似 arch 预览（布局示意，非权威）" }));
    det.appendChild(el("p", { class: "muted", text: "自定义视图渲染为 OWL 组件，仅标注。权威结果请用 python3 -m oview.pipeline。" }));
    det.appendChild(el("pre", { id: "archOut" }));
    card.appendChild(det);

    // 卡片此时仍是 detached 节点，必须用局部引用绑定事件；
    // document.querySelector("#dlBtn") 会返回 null（首次渲染时曾导致脚本中断）。
    dlBtn.addEventListener("click", () => { const { yaml } = currentOutput(); const blob = new Blob([yaml], { type: "text/yaml" }); const a = el("a", { href: URL.createObjectURL(blob), download: (state.module || "dsl") + ".yaml" }); document.body.appendChild(a); a.click(); a.remove(); });
    copyBtn.addEventListener("click", () => { const { yaml } = currentOutput(); navigator.clipboard.writeText(yaml).then(() => { copyBtn.textContent = "已复制"; setTimeout(() => (copyBtn.textContent = "复制"), 1200); }); });
    // renderOutput() 由 renderRight() 在卡片插入 document 之后调用
    return card;
  }

  // ── 校验 / 输出 ──
  function toCleanSpec() {
    const s = JSON.parse(JSON.stringify(state, (k, v) => (k.startsWith("_") ? undefined : v)));
    s.bindings.forEach((b) => (b.views || []).forEach((v) => { delete v._i; }));
    return s;
  }
  function leanValidate() {
    const errs = [];
    if (!state.module) errs.push("根节点缺少 module");
    if (!Array.isArray(state.bindings) || !state.bindings.length) errs.push("bindings 必须非空");
    // ── 三类自定义注册表（§2.1）：与后端 check_registry_refs 同结论 ──
    const reservedTypes = new Set(STANDARD_TYPES.concat(["custom"]));
    const tIds = new Set(), eDefs = new Set();
    (state.viewTypes || []).forEach((t, i) => {
      const p = "viewTypes[" + i + "]";
      if (!t.id) errs.push(p + ": 缺 id（类型键）");
      else if (tIds.has(t.id)) errs.push(p + ": id '" + t.id + "' 重复");
      else if (reservedTypes.has(t.id)) errs.push(p + ": id '" + t.id + "' 与标准/兼容类型同名");
      if (t.id) tIds.add(t.id);
    });
    (state.viewElements || []).forEach((d, i) => {
      const p = "viewElements[" + i + "]";
      if (!d.id) errs.push(p + ": 缺 id（引用名）");
      else if (eDefs.has(d.id)) errs.push(p + ": id '" + d.id + "' 重复");
      else if (KIND_DEFS[d.id]) errs.push(p + ": id '" + d.id + "' 与内置 kind 同名");
      if (d.id) eDefs.add(d.id);
      (d.props || []).forEach((q, j) => { if (!q || !q.name) errs.push(p + ".props[" + j + "]: 缺 name"); });
    });
    state.bindings.forEach((b, i) => {
      if (b.viewType && !reservedTypes.has(b.viewType) && !tIds.has(b.viewType))
        errs.push("bindings[" + i + "]: viewType '" + b.viewType + "' 未在 viewTypes[] 注册");
      (b.views || []).forEach((v, j) => {
        if (v.viewType && !reservedTypes.has(v.viewType) && !tIds.has(v.viewType))
          errs.push("bindings[" + i + "].views[" + j + "]: viewType 未在 viewTypes[] 注册");
        if (isExtension(v) && (b.viewType === "custom" || tIds.has(b.viewType) || b.custom))
          errs.push("bindings[" + i + "].views[" + j + "]: 自定义视图类型不支持切片 inherit（后端 B 不预合并）");
      });
    });
    (state.compositions || []).forEach((c, i) => {
      (c.views || []).forEach((r, j) => {
        if (r.viewType && !reservedTypes.has(r.viewType) && !tIds.has(r.viewType))
          errs.push("compositions[" + i + "].views[" + j + "]: viewType 未在 viewTypes[] 注册");
      });
    });
    state.bindings.forEach((b, i) => {
      const bid = "bindings[" + i + "]"; if (!b.model) errs.push(bid + ": 缺 model"); if (!b.viewType) errs.push(bid + ": 缺 viewType");
      const modelDef = getModel(b.model);
      const views = b.views || [];
      const ids = views.map((v) => v.id);
      if (ids.some((x) => !x) || new Set(ids).size !== ids.length) errs.push(bid + ": 层 id 重复或缺失");
      const primaries = views.filter((v) => !isExtension(v));
      const slices = views.filter(isExtension);
      if (primaries.length > 1) errs.push(bid + ": 只能有一个基础层 (primary)");
      if (!primaries.length && !slices.every((v) => isExternalInherit(v.inherit)))
        errs.push(bid + ": 缺少基础层，且切片未全部收敛到外部基视图");
      if (primaries.length && views.length && isExtension(views[0]))
        errs.push(bid + ": 层 0 必须是基础层 (primary)");
      views.forEach((v, j) => {
        const vid = bid + ".views[" + j + "]";
        if (!v.id) errs.push(vid + ": 缺 id");
        if (isExtension(v)) {
          if (!v.inherit) errs.push(vid + ": 切片必须有 inherit");
          else if (!isExternalInherit(v.inherit)) {
            if (ids.indexOf(v.inherit) < 0) errs.push(vid + ": inherit 目标 '" + v.inherit + "' 不存在");
            else if (ids.indexOf(v.inherit) >= j) errs.push(vid + ": inherit 必须指向前序层");
          }
          if (v.elements && v.elements.length) errs.push(vid + ": 切片不应带 elements（生成器只消费 patches）");
        } else {
          if (v.inherit) errs.push(vid + ": 基础层不应带 inherit");
          if (v.patches && v.patches.length) errs.push(vid + ": 基础层不应带 patches");
        }
        (v.patches || []).forEach((p, k) => {
          const pid = vid + ".patches[" + k + "]";
          if (!p.xpath || !String(p.xpath).trim()) errs.push(pid + ": 缺 xpath");
          if (UNSTABLE_XPATH.test(p.xpath || "")) errs.push(pid + ": xpath 不得用 @string/@for 定位（可能命中多个节点），请改用 @name 或字段锚点");
          if (PATCH_POSITIONS.indexOf(p.position) < 0) errs.push(pid + ": position 非法");
          if (p.position === "attributes") {
            if (!p.attrs || !p.attrs.length) errs.push(pid + ": attributes 模式需要 attrs");
            if (p.elements && p.elements.length) errs.push(pid + ": attributes 模式不接受 elements");
            (p.attrs || []).forEach((a, ai) => { if (!a.name) errs.push(pid + ".attrs[" + ai + "]: 缺 name"); });
          } else if (p.attrs && p.attrs.length) {
            errs.push(pid + ": position=" + p.position + " 不接受 attrs");
          }
          // 切片内元素与主视图同标准（后端 dsl_validate 同步做了同样的事）
          validateElements(p.elements || [], pid + ".elements", modelDef, errs);
          (p.elements || []).forEach((e, ei) => {
            if (e && STRUCTURE_SCOPE[e.kind] && STRUCTURE_SCOPE[e.kind].indexOf(b.viewType) < 0)
              errs.push(pid + ".elements[" + ei + "]: " + e.kind + " 不适用于 viewType=" + b.viewType);
          });
        });
        validateElements(v.elements || [], vid + ".elements", modelDef, errs);
        if (!isExtension(v)) validateStructure(v.elements || [], vid + ".elements", b.viewType, errs);
      });
    });
    (state.compositions || []).forEach((c, i) => { if (!c.model) errs.push("compositions[" + i + "]: 缺 model"); if (!Array.isArray(c.views) || !c.views.length) errs.push("compositions[" + i + "]: 至少一个 view"); });
    (state.menus || []).forEach((m, i) => { if (!m.id) errs.push("menus[" + i + "]: 缺 id"); if (!m.name) errs.push("menus[" + i + "]: 缺 name"); });
    (state.actions || []).forEach((a, i) => {
      const aid = "actions[" + i + "]";
      if (!a.id) errs.push(aid + ": 缺 id");
      if (a.type === "url" && !a.url) errs.push(aid + ": type=url 缺 url");
      if (a.type === "server" && !a.model) errs.push(aid + ": type=server 缺 model");
      if (a.type === "client" && !a.tag) errs.push(aid + ": type=client 缺 tag");
    });
    return errs;
  }
  function validateElements(arr, basePath, modelDef, errs) {
    (arr || []).forEach((e, k) => {
      const eid = basePath + "[" + k + "]";
      if (!e.kind) { errs.push(eid + ": 缺 kind"); return; }
      const def = KIND_DEFS[e.kind]; if (!def) { errs.push(eid + ": 未知 kind '" + e.kind + "'"); return; }
      (def.req || []).forEach((r) => { if (e[r] === undefined || e[r] === "" || e[r] === null) errs.push(eid + " (" + e.kind + ") 缺必填 '" + r + "'"); });
      if (e.kind === "customElement") {
        const d = viewElementDef(e.ref);
        if (!d) errs.push(eid + ": ref '" + (e.ref || "") + "' 未在 viewElements[] 注册");
        else (d.props || []).forEach((p) => {
          if (p && p.required && !(e.props && e.props[p.name] !== undefined) && p.default === undefined)
            errs.push(eid + ": 自定义元素缺必需 prop '" + p.name + "'");
        });
      }
      if (e.kind === "field" && modelDef) {
        const f = fieldOf(modelDef, e.name);
        if (!f) errs.push(eid + ": 字段 '" + e.name + "' 不在模型 " + modelDef.name + " 中");
        else if (e.widget) { const sug = widgetSuggestions(f.type); if (sug.length && !sug.includes(e.widget)) errs.push(eid + ": widget '" + e.widget + "' 不是类型 " + f.type + " 的常规控件"); }
      }
      if (def.children && e.children && e.children.length) validateElements(e.children, eid + ".children", modelDef, errs);
    });
  }
  // 结构条检查：与后端 validator/dsl_validate.check_structure_elements 同结论
  function validateStructure(elements, basePath, viewType, errs) {
    STRUCTURE_KINDS.forEach((kind) => {
      const pos = [];
      (elements || []).forEach((e, i) => { if (e && e.kind === kind) pos.push(i); });
      if (pos.length > 1) errs.push(basePath + ": 出现 " + pos.length + " 个 " + kind + "（arch 最多允许一个）");
      if (pos.length && STRUCTURE_SCOPE[kind].indexOf(viewType) < 0)
        errs.push(basePath + ": " + kind + " 不适用于 viewType=" + viewType +
          "（允许 " + STRUCTURE_SCOPE[kind].join(" / ") + "）");
      pos.forEach((i) => {
        const want = kind === "header" ? 0 : elements.length - 1;
        if (i !== want) errs.push(basePath + "[" + i + "]: " + kind + " 必须是根 elements 的" +
          (kind === "header" ? "首元素" : "末尾元素"));
      });
    });
    (elements || []).forEach((e, i) => {
      const walk = (x, p) => {
        if (!x || typeof x !== "object") return;
        (x.children || []).forEach((c, ci) => {
          if (c && STRUCTURE_KINDS.indexOf(c.kind) >= 0)
            errs.push(p + ".children[" + ci + "]: " + c.kind + " 不能嵌套在容器内（只能是视图根元素）");
          walk(c, p + ".children[" + ci + "]");
        });
        (x.pages || []).forEach((pg, pi) => (pg.children || []).forEach((c, ci) => {
          const cp = p + ".pages[" + pi + "].children[" + ci + "]";
          if (c && STRUCTURE_KINDS.indexOf(c.kind) >= 0)
            errs.push(cp + ": " + c.kind + " 不能嵌套在容器内（只能是视图根元素）");
          walk(c, cp);
        }));
      };
      walk(e, basePath + "[" + i + "]");
    });
  }
  function ajvCtor() {
    // 兼容 Ajv 8 各浏览器构建的导出形态：2020.bundle.js → window.ajv2020，
    // ajv.bundle.js → window.ajv，某些打包形态把构造器挂在 .Ajv / .default 上。
    for (const c of [window.ajv2020, window.ajv, window.Ajv]) {
      if (typeof c === "function") return c;
      if (c && typeof c.Ajv === "function") return c.Ajv;
      if (c && typeof c.default === "function") return c.default;
    }
    return null;
  }
  function fullValidate() {
    const Ctor = ajvCtor();
    if (!liveSchema || !Ctor) return null;   // 离线：由 lean 校验兜底
    try {
      const ajv = new Ctor({ allErrors: true, strict: false });
      const v = ajv.compile(liveSchema);
      const ok = v(toCleanSpec());
      return ok ? [] : (v.errors || []).map((e) => (e.instancePath || "/") + " " + e.message);
    } catch (e) {
      return ["schema 编译失败: " + e.message +
        "（本契约是 Draft 2020-12，需 ajv@8/dist/2020.bundle.js 或等价的 2020-12 校验器）"];
    }
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function attrsOf(e) {
    const skip = new Set(["kind", "children", "pages", "extra", "_i"]);
    const out = [];
    // 与生成器 qweb_ir._set_if 对齐：布尔属性写 "1"/"0"，不写 "true"/"false"
    const fmt = (v) => (typeof v === "boolean" ? (v ? "1" : "0") : v);
    for (const k in e) {
      if (skip.has(k)) continue;
      const val = e[k];
      if (val === "" || val == null) continue;
      out.push(k + '="' + esc(fmt(val)) + '"');
    }
    if (e.extra && typeof e.extra === "object")
      for (const k in e.extra) out.push(k + '="' + esc(fmt(e.extra[k])) + '"');
    return out.join(" ");
  }
  function customElementAttrs(e) {
    // customElement 的 arch 属性 = 一等键（排除 ref/props）+ props 逐键铺平，
    // 与后端 qweb_ir 的 customElement 分支对称；标签名来自注册表 tag。
    const skip = new Set(["kind", "children", "pages", "extra", "_i", "ref", "props"]);
    const out = [];
    for (const k in e) {
      if (skip.has(k) || e[k] === "" || e[k] == null) continue;
      out.push(k + '="' + esc(e[k]) + '"');
    }
    for (const k in (e.props || {})) out.push(k + '="' + esc(e.props[k]) + '"');
    return out.join(" ");
  }
  function elemToXml(e, depth) {
    const pad = "  ".repeat(depth);
    // notebook 的子结构是 pages[{string, children}]，不是 children[]：
    // 走通用 attrsOf 会把数组拼成 pages="[object Object]" 并丢掉所有页。
    if (e.kind === "notebook") {
      const inner = (e.pages || []).map((pg) => {
        const ppad = "  ".repeat(depth + 1);
        const head = ppad + '<page string="' + esc(pg.string || "") + '">';
        const kids = (pg.children || []).map((c) => elemToXml(c, depth + 2)).join("\n");
        return head + (kids ? "\n" + kids + "\n" + ppad : "") + "</page>";
      }).join("\n");
      return pad + "<notebook>" + (inner ? "\n" + inner + "\n" + pad : "") + "</notebook>";
    }
    const a = e.kind === "customElement" ? customElementAttrs(e) : attrsOf(e);
    const def = KIND_DEFS[e.kind] || {};
    let open, close, selfClose = false, inner = "";
    switch (e.kind) {
      case "if": open = '<t t-if="' + esc(e.cond) + '">'; close = "</t>"; break;
      case "foreach": open = '<t t-foreach="' + esc(e.expr) + '" t-as="' + esc(e.as) + '">'; close = "</t>"; break;
      case "set": open = '<t t-set="' + esc(e.name) + '" t-value="' + esc(e.value) + '"/>'; selfClose = true; break;
      case "dynamicAttr": { const m = e.mode || "attr"; open = m === "map" ? '<t t-att="' + esc(e.value) + '"/>' : '<t t-att-' + esc(e.attr) + '="' + esc(e.value) + '"/>'; selfClose = true; break; }
      case "call": open = '<t t-call="' + esc(e.name) + '"/>'; selfClose = true; break;
      case "slot": open = '<t t-slot="' + esc(e.name || "") + '"/>'; selfClose = true; break;
      case "component": open = "<" + esc(e.name) + " " + a + "/>"; selfClose = true; break;
      case "customElement": {
        const d = viewElementDef(e.ref);
        open = "<" + esc((d && d.tag) || e.ref || "customElement") + (a ? " " + a : "") + "/>";
        selfClose = true; break;
      }
      case "raw": return pad + "<!-- raw (" + esc(e.reason) + ") -->\n" + pad + (e.qweb || "");
      default: open = "<" + esc(e.kind) + (a ? " " + a : "") + ">"; close = "</" + esc(e.kind) + ">";
    }
    if (def.children && e.children && e.children.length) inner = "\n" + e.children.map((c) => elemToXml(c, depth + 1)).join("\n") + "\n" + pad;
    if (selfClose) return pad + open; return pad + open + inner + close;
  }
  function buildArch() {
    const lines = [];
    state.bindings.forEach((b) => { (b.views || []).forEach((v) => {
      const mode = v.mode || "primary";
      if (isCustomVType(b.viewType) && mode === "primary")
        lines.push("<!-- 自定义 view type '" + esc(b.viewType) + "' → 后端 B 生成 OWL 三件套 -->");
      const rootTag = b.viewType === "list" || b.viewType === "tree" ? "tree" : b.viewType;
      if (mode === "extension") {
        // extension arch 的根就是 <data>，与生成器 backend_a 一致
        lines.push("<!-- 切片 " + esc(v.id) + " → inherit: " + esc(v.inherit || "") + " -->");
        lines.push("<data>");
        (v.patches || []).forEach((p) => {
          const pos = p.position || "after";
          lines.push('  <xpath expr="' + esc(p.xpath || "") + '" position="' + esc(pos) + '">');
          if (pos === "attributes") {
            (p.attrs || []).forEach((at) => lines.push('    <attribute name="' + esc(at.name || "") + '">' + esc(at.value != null ? at.value : "") + "</attribute>"));
          } else {
            (p.elements || []).forEach((e) => lines.push(elemToXml(e, 2)));
          }
          lines.push("  </xpath>");
        });
        lines.push("</data>");
        return;
      }
      lines.push("<" + rootTag + ' id="' + esc(v.id) + '">');
      (v.elements || []).forEach((e) => lines.push(elemToXml(e, 1)));
      lines.push("</" + rootTag + ">");
    }); });
    return lines.join("\n");
  }
  function currentOutput() {
    const clean = toCleanSpec();
    let yaml; try { yaml = window.jsyaml ? window.jsyaml.dump(clean, { lineWidth: 120, noRefs: true }) : JSON.stringify(clean, null, 2); } catch (_) { yaml = JSON.stringify(clean, null, 2); }
    return { yaml, clean };
  }
  function renderOutput() {
    const { yaml } = currentOutput();
    const yo = $("#yamlOut"); if (yo) yo.textContent = yaml;
    const lean = leanValidate(); const full = fullValidate();
    const errs = full ? lean.concat(full.filter((x) => !lean.includes(x))) : lean;
    const st = $("#status");
    if (!st) return;
    if (errs.length) {
      st.className = "status err"; st.innerHTML = "✗ " + errs.length + " 个结构问题" + (full ? "（已用加载的 schema 权威校验）" : "（lean 校验；可加载 schema 做权威校验）");
      const ul = el("ul", { class: "errs" }); errs.slice(0, 20).forEach((m) => ul.appendChild(el("li", { text: m }))); st.appendChild(ul);
    } else { st.className = "status ok"; st.textContent = full ? "✓ DSL 通过 schema 权威校验" : "✓ DSL 通过 lean 校验（结构完整）"; }
    const arch = $("#archOut"); if (arch) arch.textContent = buildArch() || "<!-- 暂无可预览的标准视图 -->";
  }

  // ── 启动 ──
  // 预载示例模型，画布开箱即所见即所得（状态栏 pills / 真实字段控件）
  Object.values(SAMPLE_MODELS).forEach((d) => { modelRegistry[d.name] = d; });
  renderToolbox();
  renderCanvas();
  renderRight();

  // 画布点击委托：命中 [data-path] 即选中该元素；点空白处取消
  const cvEl = $("#canvas");
  if (cvEl) cvEl.addEventListener("click", (e) => {
    const t = e.target;
    const node = t && t.closest ? t.closest("[data-path]") : null;
    if (node) selectElement(node.getAttribute("data-path"), node.getAttribute("data-xpath"));
    else if (t === cvEl) selectElement(null);
  });
})();
