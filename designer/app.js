/* Odoo View DSL · Designer prototype (canvas)
 * 三栏：左=工具箱(模型/字段面板)，中=画布(所见即所得)，右=检查器+DSL。
 * 角色：把用户意图编译成 DSL（契约 = schema/dsl_schema.json）。不产出 QWeb；
 * 转换由 Python 管线 oview.pipeline 完成。
 *
 * 模型定义（model def）是「意图编译」的必要上下文：
 *   model def -> 知道有哪些字段、各自类型 -> 才能做字段摆放与显示控制。
 * 模型定义只存在于设计器（UI 上下文），不写入 DSL 产物。
 */
(function () {
  "use strict";

  // ── kind 定义 ──
  const KIND_DEFS = {
    field:       { req: ["name"], opt: ["string", "widget", "options", "colspan", "invisible", "readonly", "required", "domain", "context", "groups"], children: false },
    group:       { children: true, opt: ["string", "col", "colspan"] },
    notebook:    { children: true },
    page:        { children: true, opt: ["string"] },
    button:      { req: ["string"], opt: ["type", "name", "icon", "groups"] },
    separator:   { opt: ["string"] },
    label:       { opt: ["string", "for"] },
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
  };
  const KINDS = Object.keys(KIND_DEFS);
  const VIEW_TYPES = ["form", "list", "tree", "search", "graph", "pivot", "calendar", "activity", "dashboard", "custom"];
  const CONTAINER_KINDS = ["group", "notebook", "page", "if", "foreach"];

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
    date: ["date"], datetime: ["datetime"], selection: ["selection", "radio"],
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
        { name: "state", type: "selection", string: "状态", readonly: true },
        { name: "user_id", type: "many2one", string: "销售员", relation: "res.users" },
        { name: "pricelist_id", type: "many2one", string: "价格表", relation: "product.pricelist" },
        { name: "order_line", type: "one2many", string: "订单明细", relation: "sale.order.line" },
        { name: "note", type: "text", string: "备注" },
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
        { name: "state", type: "selection", string: "状态", readonly: true },
        { name: "currency_id", type: "many2one", string: "币种", relation: "res.currency", readonly: true },
        { name: "company_id", type: "many2one", string: "公司", relation: "res.company" }
      ]
    }
  };

  // ── 状态（四层模型）──
  const state = {
    module: "dsl_gen",
    bindings: [{
      model: "res.partner", viewType: "form",
      views: [{
        id: "base", mode: "primary",
        elements: [
          { kind: "group", string: "Primary", children: [
            { kind: "field", name: "name" },
            { kind: "field", name: "email", widget: "email" },
          ]},
          { kind: "button", string: "Action", type: "object" },
        ],
      }],
    }],
    compositions: [{ kind: "act_window", id: "action_partner", model: "res.partner", name: "Partners", views: [{ viewType: "form" }], target: "current" }],
    actions: [],
    menus: [{ id: "partner_root", name: "Contacts" }, { id: "partner_menu", name: "Partners", action: "action_partner", parent: "partner_root" }],
  };

  // UI-only（不进 DSL）
  let liveSchema = null;
  let selectedPath = null;          // 当前选中元素的路径
  let activeB = 0, activeV = 0;      // 画布当前编辑的 binding/view
  const notebookActive = {};         // notebook path -> 当前页索引
  let dragField = null;              // 拖拽兜底

  // ── 工具 ──
  const $ = (s) => document.querySelector(s);
  function el(tag, props, kids) {
    const n = document.createElement(tag);
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
    if (selectedPath) {
      const e = getPath(state, selectedPath);
      if (e && KIND_DEFS[e.kind] && KIND_DEFS[e.kind].children) {
        if (!e.children) e.children = [];
        return selectedPath + ".children";
      }
    }
    const a = getActive(); if (a.view && !a.view.elements) a.view.elements = [];
    return "bindings[" + activeB + "].views[" + activeV + "].elements";
  }

  function rerenderAll() { renderToolbox(); renderCanvas(); renderRight(); }
  function updateCanvas() { renderCanvas(); renderOutput(); }

  // ════════════ 左栏：工具箱 ════════════
  function renderModelsCard() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "Models（字段来源）" }));
    card.appendChild(el("p", { class: "muted", text: "先获得模型定义，才知道有哪些字段，进而做摆放与显示控制。可加载示例，或上传 JSON。" }));
    const loadSample = el("button", { class: "sm", text: "加载示例模型", onclick: () => { Object.values(SAMPLE_MODELS).forEach((d) => { modelRegistry[d.name] = d; }); rerenderAll(); } });
    const fileInput = el("input", { type: "file", accept: ".json", multiple: "multiple", style: "width:auto;font-size:12px", onchange: (e) => {
      const files = Array.from(e.target.files || []); let pending = files.length; if (!pending) return;
      files.forEach((f) => { const r = new FileReader(); r.onload = () => { try { loadModelDefs(JSON.parse(r.result)); } catch (err) { alert("模型 JSON 解析失败: " + f.name + " - " + err.message); } if (--pending === 0) rerenderAll(); }; r.readAsText(f); });
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
      chip.addEventListener("dragstart", (e) => { dragField = f.name; try { e.dataTransfer.setData("text/plain", f.name); } catch (_) {} });
      chip.addEventListener("dragend", () => { dragField = null; });
      chip.addEventListener("click", () => { const arr = getPath(state, getAddTargetPath()); if (Array.isArray(arr)) { arr.push({ kind: "field", name: f.name }); rerenderAll(); } });
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

  function renderAddButtons() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "添加元素（落入当前选中容器）" }));
    const add = (kind, obj) => { const arr = getPath(state, getAddTargetPath()); if (Array.isArray(arr)) { arr.push(obj); rerenderAll(); } };
    const btns = [
      ["+ 分组", () => add("group", { kind: "group", string: "分组", children: [] })],
      ["+ 笔记本", () => add("notebook", { kind: "notebook", children: [{ kind: "page", string: "页 1", children: [] }] })],
      ["+ 按钮", () => add("button", { kind: "button", string: "按钮", type: "object" })],
      ["+ 分隔线", () => add("separator", { kind: "separator" })],
      ["+ 标签", () => add("label", { kind: "label", string: "标签" })],
    ];
    const wrap = el("div", { class: "addbtns" });
    btns.forEach(([t, fn]) => wrap.appendChild(el("button", { class: "sm", text: t, onclick: fn })));
    card.appendChild(wrap);
    card.appendChild(el("p", { class: "muted", text: "提示：先在画布点选一个分组/页，新元素会落进去；否则落进根。" }));
    return card;
  }

  function renderTree() {
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", { text: "结构" }));
    const lines = [];
    state.bindings.forEach((b, bi) => {
      lines.push((bi === activeB ? "▶ " : "  ") + "binding: " + b.model + " / " + b.viewType);
      (b.views || []).forEach((v, vi) => { lines.push("   " + (bi === activeB && vi === activeV ? "● " : "○ ") + v.id + " (" + (v.mode || "primary") + ")"); treeElems(v.elements, "     "); });
    });
    function treeElems(arr, ind) { (arr || []).forEach((e) => { lines.push(ind + (e.kind === "field" ? "⨀ " + e.name : "▣ " + e.kind)); if (e.children) treeElems(e.children, ind + "  "); }); }
    card.appendChild(el("div", { class: "tree", text: lines.join("\n") }));
    return card;
  }

  function renderToolbox() {
    const left = $("#left"); left.innerHTML = "";
    const mod = el("div", { class: "card" });
    mod.appendChild(el("h2", { text: "Module" }));
    mod.appendChild(el("input", { value: state.module, oninput: (e) => { state.module = e.target.value; renderOutput(); } }));
    left.appendChild(mod);
    left.appendChild(renderModelsCard());
    left.appendChild(renderPalette());
    left.appendChild(renderAddButtons());
    left.appendChild(renderTree());
  }

  // ════════════ 中栏：画布 ════════════
  function renderCanvasBar() {
    const bar = $("#canvasBar"); bar.innerHTML = "";
    const a = getActive();
    bar.appendChild(el("span", { class: "hint", text: "画布：" }));
    const bs = el("select", { onchange: (e) => { activeB = +e.target.value; activeV = 0; rerenderAll(); } });
    state.bindings.forEach((b, i) => bs.appendChild(el("option", { value: i, text: (b.model || "?") + " / " + b.viewType, selected: i === activeB ? "selected" : null })));
    bar.appendChild(bs);
    // 主模型切换：改变当前 binding 绑定的模型，字段面板随之更新
    const modelKeys = Object.keys(modelRegistry);
    const cur = a.binding && a.binding.model;
    if (modelKeys.length) {
      if (cur && !modelKeys.includes(cur)) modelKeys.unshift(cur);
      const msel = el("select", { title: "切换主模型（当前 binding 绑定的模型）", onchange: (e) => { if (a.binding) { a.binding.model = e.target.value || null; rerenderAll(); } } });
      bar.appendChild(el("span", { class: "hint", text: "模型" }));
      modelKeys.forEach((m) => msel.appendChild(el("option", { value: m, text: m, selected: m === cur ? "selected" : null })));
      bar.appendChild(msel);
    } else {
      bar.appendChild(el("span", { class: "hint", text: "模型：" + (cur || "（未加载，点左栏『加载示例模型』）") }));
    }
    const vs = el("select", { onchange: (e) => { activeV = +e.target.value; rerenderAll(); } });
    (a.binding.views || []).forEach((v, i) => vs.appendChild(el("option", { value: i, text: v.id + " (" + (v.mode || "primary") + ")", selected: i === activeV ? "selected" : null })));
    bar.appendChild(vs);
  }

  function renderCanvas() {
    const cv = $("#canvas"); cv.innerHTML = "";
    const a = getActive();
    if (!a.view) { cv.appendChild(el("div", { class: "muted", text: "无可用视图" })); return; }
    const sheet = el("div", { class: "sheet" });
    sheet.addEventListener("click", (e) => { if (e.target === sheet) selectElement(null); });
    sheet.appendChild(el("div", { class: "sheet-head" }, [el("span", { text: a.binding.viewType + " · " + a.view.id }), el("span", { text: a.binding.model })]));
    if (a.binding.viewType === "custom") {
      sheet.appendChild(el("div", { class: "cv-logic", text: "custom 视图 → OWL 组件（见生成产物）。画布仅标注。" }));
    } else {
      (a.view.elements || []).forEach((e, i) => sheet.appendChild(canvasElem(e, "bindings[" + activeB + "].views[" + activeV + "].elements[" + i + "]", a.modelName, 0)));
      sheet.appendChild(renderDropzone("bindings[" + activeB + "].views[" + activeV + "].elements", a.modelDef));
    }
    cv.appendChild(sheet);
    renderCanvasBar();
  }

  function fieldControlVisual(f, elem) {
    const type = (f && f.type) || "char";
    const w = elem.widget;
    let cls = "cv-ctl", txt = "…";
    if (type === "boolean") { cls += " bool"; txt = "☑ / ☐"; }
    else if (type === "text") { cls += " ta"; txt = ""; }
    else if (type === "selection") { txt = "▾ 选择…"; }
    else if (type === "many2one") { cls += " m2o"; txt = "搜索…"; }
    else if (type === "one2many" || type === "many2many") { cls += " x2m"; txt = "⊞ (N 条记录)"; }
    else if (type === "date" || type === "datetime") { txt = "📅 " + type; }
    else if (type === "monetary" || type === "float" || type === "integer") { txt = "0.00"; }
    else if (type === "binary") { txt = "🖼 文件"; }
    else if (w === "email") txt = "name@example.com";
    else if (w === "url") txt = "https://";
    else if (w === "phone") txt = "+00 000";
    return el("div", { class: cls, text: txt });
  }

  function canvasElem(elem, path, modelName, depth) {
    const def = KIND_DEFS[elem.kind] || {};
    const isSel = path === selectedPath;
    const modelDef = getModel(modelName);

    // 逻辑类（非可视字段）以标注呈现
    if (["if", "foreach", "set", "slot", "call", "dynamicAttr", "raw"].includes(elem.kind)) {
      const b = el("div", { class: "cv-logic" + (isSel ? " sel" : ""), text: "⟨" + elem.kind + (elem.cond ? " " + elem.cond : elem.name ? " " + elem.name : "") + "⟩" });
      b.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      return b;
    }

    if (elem.kind === "field") {
      const f = fieldOf(modelDef, elem.name);
      const block = el("div", { class: "cv-field" + (isSel ? " sel" : "") });
      const label = el("div", { class: "cv-label", text: (elem.string || (f && f.string) || elem.name || "字段") + ((f && f.required) ? " *" : "") });
      if (f && f.required) label.appendChild(el("span", { class: "req", text: " *" }));
      block.appendChild(label);
      block.appendChild(fieldControlVisual(f, elem));
      if (f) block.appendChild(el("div", { class: "typebadge", text: f.type + (f.relation ? " → " + f.relation : "") }));
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) block.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      block.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      return block;
    }

    if (elem.kind === "button") {
      const b = el("div", { class: "cv-field" + (isSel ? " sel" : "") });
      b.appendChild(el("div", { class: "cv-label", text: "按钮" }));
      b.appendChild(el("div", { class: "cv-button", text: elem.string || "Button" }));
      b.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      return b;
    }

    if (elem.kind === "separator") {
      const s = el("div", { class: "cv-separator" }, [el("span", { text: elem.string || "" })]);
      s.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      return s;
    }

    if (elem.kind === "label") {
      const l = el("div", { class: "cv-label-el" + (isSel ? " sel" : ""), text: elem.string || "标签" });
      l.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      return l;
    }

    // 容器：group / notebook / page
    if (elem.kind === "group") {
      const box = el("div", { class: "cv-group" + (isSel ? " sel" : "") });
      const title = el("div", { class: "cv-title" }, [el("span", { text: elem.string || "分组" }), el("span", { class: "muted", text: "点选编辑" })]);
      title.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      box.appendChild(title);
      const cols = (elem.col && parseInt(elem.col, 10) > 0) ? parseInt(elem.col, 10) : 2;
      const grid = el("div", { class: "cv-grid", style: "grid-template-columns:repeat(" + cols + ",1fr)" });
      (elem.children || []).forEach((c, ci) => grid.appendChild(canvasElem(c, path + ".children[" + ci + "]", modelName, depth + 1)));
      box.appendChild(grid);
      box.appendChild(renderDropzone(path + ".children", modelDef));
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) box.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      box.addEventListener("click", (e) => { if (e.target === box) selectElement(path); });
      return box;
    }
    if (elem.kind === "page") {
      const box = el("div", { class: "cv-group" + (isSel ? " sel" : "") });
      const title = el("div", { class: "cv-title" }, [el("span", { text: elem.string || "页" }), el("span", { class: "muted", text: "点选编辑" })]);
      title.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
      box.appendChild(title);
      const grid = el("div", { class: "cv-grid" });
      (elem.children || []).forEach((c, ci) => grid.appendChild(canvasElem(c, path + ".children[" + ci + "]", modelName, depth + 1)));
      box.appendChild(grid);
      box.appendChild(renderDropzone(path + ".children", modelDef));
      if (elem.colspan && parseInt(elem.colspan, 10) > 1) box.style.gridColumn = "span " + parseInt(elem.colspan, 10);
      box.addEventListener("click", (e) => { if (e.target === box) selectElement(path); });
      return box;
    }
    if (elem.kind === "notebook") {
      const box = el("div", { class: "cv-notebook" + (isSel ? " sel" : ""), onclick: (e) => { if (e.target === box) selectElement(path); } });
      const pages = (elem.children || []).filter((c) => c.kind === "page");
      const tabs = el("div", { class: "cv-tabs" });
      const activeIdx = notebookActive[path] != null ? notebookActive[path] : 0;
      pages.forEach((p, pi) => {
        const tab = el("div", { class: "cv-tab" + (pi === activeIdx ? " active" : ""), text: p.string || ("页 " + (pi + 1)) });
        tab.addEventListener("click", (e) => { e.stopPropagation(); notebookActive[path] = pi; renderCanvas(); });
        tabs.appendChild(tab);
      });
      box.appendChild(tabs);
      const page = pages[activeIdx];
      const panel = el("div", { class: "cv-page" });
      if (page) {
        const pgrid = el("div", { class: "cv-grid" });
        (page.children || []).forEach((c, ci) => pgrid.appendChild(canvasElem(c, path + ".children[" + pages.indexOf(page) + "].children[" + ci + "]", modelName, depth + 1)));
        panel.appendChild(pgrid);
        panel.appendChild(renderDropzone(path + ".children[" + pages.indexOf(page) + "].children", modelDef));
      }
      box.appendChild(panel);
      // 笔记本头部点选（非 tab 区）
      tabs.addEventListener("click", (e) => { if (e.target === tabs) selectElement(path); });
      return box;
    }

    // 其它未知 kind 兜底
    const b = el("div", { class: "cv-logic" + (isSel ? " sel" : ""), text: "▣ " + elem.kind });
    b.addEventListener("click", (e) => { e.stopPropagation(); selectElement(path); });
    return b;
  }

  function renderDropzone(arrPath, modelDef) {
    const dz = el("div", { class: "cv-dropzone" });
    dz.appendChild(el("span", { text: "⤵ 拖拽字段到此，或 " }));
    if (modelDef) {
      const sel = el("select", { onchange: (e) => { if (e.target.value) { const arr = getPath(state, arrPath); if (Array.isArray(arr)) { arr.push({ kind: "field", name: e.target.value }); e.target.value = ""; rerenderAll(); } } } });
      sel.appendChild(el("option", { value: "", text: "从模型选择字段 +" }));
      modelDef.fields.forEach((f) => sel.appendChild(el("option", { value: f.name, text: f.name + " (" + f.type + ")" })));
      dz.appendChild(sel);
    } else { dz.appendChild(el("span", { class: "muted", text: "（加载模型定义后可用）" })); }
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); const name = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || dragField; if (name) { const arr = getPath(state, arrPath); if (Array.isArray(arr)) { arr.push({ kind: "field", name }); rerenderAll(); } } });
    return dz;
  }

  function selectElement(path) { selectedPath = path; renderCanvas(); renderRight(); }

  // ════════════ 右栏：检查器 + 输出 ════════════
  function renderRight() {
    const right = $("#right"); right.innerHTML = "";
    right.appendChild(renderInspector());
    right.appendChild(renderOutputCard());
  }

  function renderInspector() {
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "insp-title" }, [el("span", { text: "检查器（显示控制）" })]));
    if (!selectedPath) {
      card.appendChild(el("div", { class: "muted", text: "在画布上点选一个元素以编辑其属性；或在左栏字段面板点选字段，落入" + (isContainerSelected() ? "选中容器" : "根") + "。" }));
      const a = getActive();
      if (a.view) {
        card.appendChild(el("label", { text: "当前视图 id" }));
        card.appendChild(el("input", { value: a.view.id || "", oninput: (e) => { a.view.id = e.target.value; renderOutput(); } }));
        const msel = el("select", { onchange: (e) => { a.view.mode = e.target.value; renderOutput(); } });
        [["primary", "primary"], ["extension", "extension"]].forEach(([v, t]) => msel.appendChild(el("option", { value: v, text: t, selected: (a.view.mode || "primary") === v ? "selected" : null })));
        card.appendChild(el("label", { text: "mode" })); card.appendChild(msel);
        if (a.view.mode === "extension") { card.appendChild(el("label", { text: "inherit" })); card.appendChild(el("input", { value: a.view.inherit || "", oninput: (e) => { a.view.inherit = e.target.value; renderOutput(); } })); }
      }
      return card;
    }
    const elem = getPath(state, selectedPath);
    const a = getActive();
    const def = KIND_DEFS[elem.kind] || {};
    card.appendChild(el("div", { class: "insp-title" }, [el("span", { text: "▣ " + elem.kind }), el("span", { class: "muted", text: selectedPath })]));
    if (elem.kind === "field") { card.appendChild(renderFieldEditor(elem, selectedPath, a.modelName)); }
    else { card.appendChild(renderGenericFields(elem, selectedPath, def)); if (def.children) card.appendChild(el("div", { class: "muted", text: "这是一个容器，可在画布拖入字段，或点选「+ 字段」。" })); }
    // move / delete
    const m = selectedPath.match(/(.*)\[(\d+)\]$/);
    if (m) {
      const arrPath = m[1], idx = +m[2];
      const row = el("div", { class: "row", style: "margin-top:8px" });
      row.appendChild(el("button", { class: "sm", text: "▲ 上移", onclick: () => { const arr = getPath(state, arrPath); if (idx > 0) { [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; rerenderAll(); } } }));
      row.appendChild(el("button", { class: "sm", text: "▼ 下移", onclick: () => { const arr = getPath(state, arrPath); if (idx < arr.length - 1) { [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]]; rerenderAll(); } } }));
      row.appendChild(el("button", { class: "sm danger", text: "删除", onclick: () => { const arr = getPath(state, arrPath); if (Array.isArray(arr)) { arr.splice(idx, 1); selectedPath = null; rerenderAll(); } } }));
      card.appendChild(row);
    }
    return card;
  }

  function renderGenericFields(elem, path, def) {
    const frag = document.createDocumentFragment();
    const NUMERIC = new Set(["col", "colspan", "priority", "sequence", "limit"]);
    const fields = [...(def.req || []), ...(def.opt || [])];
    fields.forEach((f) => {
      const val = elem[f] != null ? elem[f] : "";
      frag.appendChild(el("label", { text: f + (def.req && def.req.includes(f) ? " *" : "") }));
      if (NUMERIC.has(f)) {
        frag.appendChild(el("input", { type: "number", min: "1", value: val, oninput: (e) => { const v = e.target.value.trim(); if (v === "") delete elem[f]; else elem[f] = parseInt(v, 10) || 1; updateCanvas(); } }));
      } else {
        frag.appendChild(el("input", { value: val, oninput: (e) => { setPath(state, path + "." + f, e.target.value); updateCanvas(); } }));
      }
    });
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
    const sf = el("input", { type: "file", id: "schemaFile", accept: ".json", title: "加载实时 schema 做权威校验（可选）", style: "width:auto;font-size:12px" });
    sf.addEventListener("change", (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { liveSchema = JSON.parse(r.result); renderOutput(); } catch (err) { alert("schema 解析失败: " + err.message); } }; r.readAsText(f); });
    tb.appendChild(sf);
    tb.appendChild(el("button", { class: "sm", id: "dlBtn", text: "下载 .yaml" }));
    tb.appendChild(el("button", { class: "sm primary", id: "copyBtn", text: "复制" }));
    card.appendChild(tb);
    card.appendChild(el("div", { id: "status", class: "status warn", text: "尚未校验" }));
    card.appendChild(el("pre", { id: "yamlOut" }));
    const det = el("details");
    det.appendChild(el("summary", { text: "近似 arch 预览（布局示意，非权威）" }));
    det.appendChild(el("p", { class: "muted", text: "自定义视图渲染为 OWL 组件，仅标注。权威结果请用 python3 -m oview.pipeline。" }));
    det.appendChild(el("pre", { id: "archOut" }));
    card.appendChild(det);

    $("#dlBtn").addEventListener("click", () => { const { yaml } = currentOutput(); const blob = new Blob([yaml], { type: "text/yaml" }); const a = el("a", { href: URL.createObjectURL(blob), download: (state.module || "dsl") + ".yaml" }); document.body.appendChild(a); a.click(); a.remove(); });
    $("#copyBtn").addEventListener("click", () => { const { yaml } = currentOutput(); navigator.clipboard.writeText(yaml).then(() => { const b = $("#copyBtn"); b.textContent = "已复制"; setTimeout(() => (b.textContent = "复制"), 1200); }); });

    renderOutput();
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
    state.bindings.forEach((b, i) => {
      const bid = "bindings[" + i + "]"; if (!b.model) errs.push(bid + ": 缺 model"); if (!b.viewType) errs.push(bid + ": 缺 viewType");
      const modelDef = getModel(b.model);
      (b.views || []).forEach((v, j) => { const vid = bid + ".views[" + j + "]"; if (!v.id) errs.push(vid + ": 缺 id"); if (v.mode === "extension" && !v.inherit) errs.push(vid + ": extension 必须有 inherit"); validateElements(v.elements || [], vid + ".elements", modelDef, errs); });
    });
    (state.compositions || []).forEach((c, i) => { if (!c.model) errs.push("compositions[" + i + "]: 缺 model"); if (!Array.isArray(c.views) || !c.views.length) errs.push("compositions[" + i + "]: 至少一个 view"); });
    (state.menus || []).forEach((m, i) => { if (!m.id) errs.push("menus[" + i + "]: 缺 id"); if (!m.name) errs.push("menus[" + i + "]: 缺 name"); });
    (state.actions || []).forEach((a, i) => { const aid = "actions[" + i + "]"; if (!a.id) errs.push(aid + ": 缺 id"); if (a.type === "url" && !a.url) errs.push(aid + ": type=url 缺 url"); if (a.type === "server" && !a.model) errs.push(aid + ": type=server 缺 model"); });
    return errs;
  }
  function validateElements(arr, basePath, modelDef, errs) {
    (arr || []).forEach((e, k) => {
      const eid = basePath + "[" + k + "]";
      if (!e.kind) { errs.push(eid + ": 缺 kind"); return; }
      const def = KIND_DEFS[e.kind]; if (!def) { errs.push(eid + ": 未知 kind '" + e.kind + "'"); return; }
      (def.req || []).forEach((r) => { if (e[r] === undefined || e[r] === "" || e[r] === null) errs.push(eid + " (" + e.kind + ") 缺必填 '" + r + "'"); });
      if (e.kind === "field" && modelDef) {
        const f = fieldOf(modelDef, e.name);
        if (!f) errs.push(eid + ": 字段 '" + e.name + "' 不在模型 " + modelDef.name + " 中");
        else if (e.widget) { const sug = widgetSuggestions(f.type); if (sug.length && !sug.includes(e.widget)) errs.push(eid + ": widget '" + e.widget + "' 不是类型 " + f.type + " 的常规控件"); }
      }
      if (def.children && e.children && e.children.length) validateElements(e.children, eid + ".children", modelDef, errs);
    });
  }
  function fullValidate() {
    if (!liveSchema || !window.Ajv) return null;
    try { const ajv = new window.Ajv({ allErrors: true, strict: false }); const v = ajv.compile(liveSchema); const ok = v(toCleanSpec()); return ok ? [] : (v.errors || []).map((e) => (e.instancePath || "/") + " " + e.message); }
    catch (e) { return ["schema 编译失败: " + e.message]; }
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function attrsOf(e) { const skip = new Set(["kind", "children", "extra", "_i"]); const out = []; for (const k in e) { if (skip.has(k)) continue; const val = e[k]; if (val === "" || val == null) continue; out.push(k + '="' + esc(val) + '"'); } if (e.extra && typeof e.extra === "object") for (const k in e.extra) out.push(k + '="' + esc(e.extra[k]) + '"'); return out.join(" "); }
  function elemToXml(e, depth) {
    const pad = "  ".repeat(depth); const a = attrsOf(e); const def = KIND_DEFS[e.kind] || {};
    let open, close, selfClose = false, inner = "";
    switch (e.kind) {
      case "if": open = '<t t-if="' + esc(e.cond) + '">'; close = "</t>"; break;
      case "foreach": open = '<t t-foreach="' + esc(e.expr) + '" t-as="' + esc(e.as) + '">'; close = "</t>"; break;
      case "set": open = '<t t-set="' + esc(e.name) + '" t-value="' + esc(e.value) + '"/>'; selfClose = true; break;
      case "dynamicAttr": { const m = e.mode || "attr"; open = m === "map" ? '<t t-att="' + esc(e.value) + '"/>' : '<t t-att-' + esc(e.attr) + '="' + esc(e.value) + '"/>'; selfClose = true; break; }
      case "call": open = '<t t-call="' + esc(e.name) + '"/>'; selfClose = true; break;
      case "slot": open = '<t t-slot="' + esc(e.name || "") + '"/>'; selfClose = true; break;
      case "component": open = "<" + esc(e.name) + " " + a + "/>"; selfClose = true; break;
      case "raw": return pad + "<!-- raw (" + esc(e.reason) + ") -->\n" + pad + (e.qweb || "");
      default: open = "<" + esc(e.kind) + (a ? " " + a : "") + ">"; close = "</" + esc(e.kind) + ">";
    }
    if (def.children && e.children && e.children.length) inner = "\n" + e.children.map((c) => elemToXml(c, depth + 1)).join("\n") + "\n" + pad;
    if (selfClose) return pad + open; return pad + open + inner + close;
  }
  function buildArch() {
    const lines = [];
    state.bindings.forEach((b) => { (b.views || []).forEach((v) => { if (b.viewType === "custom") { lines.push("<!-- custom view '" + v.id + "' -> OWL component -->"); return; } lines.push("<" + b.viewType + ' id="' + esc(v.id) + '">'); (v.elements || []).forEach((e) => lines.push(elemToXml(e, 1))); lines.push("</" + b.viewType + ">"); }); });
    return lines.join("\n");
  }
  function currentOutput() {
    const clean = toCleanSpec();
    let yaml; try { yaml = window.jsyaml ? window.jsyaml.dump(clean, { lineWidth: 120, noRefs: true }) : JSON.stringify(clean, null, 2); } catch (_) { yaml = JSON.stringify(clean, null, 2); }
    return { yaml, clean };
  }
  function renderOutput() {
    const { yaml } = currentOutput();
    $("#yamlOut").textContent = yaml;
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
  renderToolbox();
  renderCanvas();
  renderRight();
})();
