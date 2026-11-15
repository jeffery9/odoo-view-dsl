/* Odoo View DSL · 框架无关的 DSL 内核（被 OWL 组件化设计器复用）
 *
 * 本文件不依赖任何 UI 框架，只提供：
 *   - 数据契约（KIND_DEFS / WIDGETS / STRUCTURE_* / VIEW_TYPES）
 *   - 校验（与后端 validator 同结论的 leanValidate + buildArch）
 *   - 导出序列化（elemToXml / buildArch / toCleanSpec）
 *   - id 树工具（injectIds / findNode / insertChild / removeNode / updateNode）
 *
 * 与 designer/ 原型保持「同契约、同输出」：YAML 产物逐字节等价（仅多一个 _id 内部字段，导出时剥离）。
 * 关键架构转变（相对原型）：
 *   - 原型：状态用「路径字符串寻址 + rerenderAll() 全量重渲染」。
 *   - 本内核：每个节点带稳定 _id，store 只做「id 树局部变更」，组件按 _id 订阅局部子树。
 */
(function (global) {
  "use strict";

  // ── kind 定义（与 designer/app.js 完全一致，保证契约等价）──
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
  const STANDARD_TYPES = VIEW_TYPES.filter((t) => t !== "custom");
  // arch 顺序敏感的结构条：只能是根 elements 的首 / 末元素，各最多一个
  const STRUCTURE_KINDS = ["header", "footer"];
  const STRUCTURE_SCOPE = { header: ["form", "list"], footer: ["form"] };

  const WIDGETS = {
    char: ["text", "email", "url", "phone", "password"], text: ["text", "html"], boolean: ["boolean", "boolean_toggle"],
    integer: ["integer", "handle", "priority"], float: ["float", "percentage", "progressbar"], monetary: ["monetary"],
    date: ["date"], datetime: ["datetime"], selection: ["selection", "radio", "statusbar"],
    many2one: ["many2one", "many2one_avatar", "many2one_button"], one2many: ["one2many", "list", "kanban", "form"],
    many2many: ["many2many", "many2many_tags", "many2many_binary", "kanban"], binary: ["binary", "image", "pdf_viewer"],
  };

  // ── id 工具 ──
  let _seq = 0;
  function freshId(prefix) { return (prefix || "n") + "_" + (++_seq); }

  // 给整棵树的所有节点注入稳定 _id（幂等：已有 _id 不覆盖）
  function injectIds(node, seen) {
    seen = seen || new Set();
    if (!node || typeof node !== "object") return;
    if (!node._id) node._id = freshId(node.kind || "node");
    if (seen.has(node._id)) return; seen.add(node._id);
    if (Array.isArray(node.children)) node.children.forEach((c) => injectIds(c, seen));
    if (Array.isArray(node.pages)) node.pages.forEach((p) => { injectIds(p, seen); if (Array.isArray(p.children)) p.children.forEach((c) => injectIds(c, seen)); });
    if (Array.isArray(node.elements)) node.elements.forEach((c) => injectIds(c, seen));
    if (Array.isArray(node.patches)) node.patches.forEach((p) => {
      if (!p._id) p._id = freshId("patch");   // patch 自身作为 elements 落点容器，需可寻址
      if (Array.isArray(p.elements)) p.elements.forEach((c) => injectIds(c, seen));
    });
  }
  function injectStateIds(state) {
    (state.bindings || []).forEach((b) => (b.views || []).forEach((v) => { injectIds(v); }));
    (state.viewTypes || []).forEach((t) => { if (!t._id) t._id = freshId("vt"); });
    (state.viewElements || []).forEach((d) => { if (!d._id) d._id = freshId("ve"); });
    (state.actions || []).forEach((a) => { if (!a._id) a._id = freshId("act"); });
  }

  // 深度遍历查找节点，返回 { node, parent, index, path, container }
  function findNode(root, id, ctx) {
    ctx = ctx || { parent: null, index: -1, path: "", container: null };
    if (!root || typeof root !== "object") return null;
    if (root._id === id) return { node: root, parent: ctx.parent, index: ctx.index, path: ctx.path, container: ctx.container };
    const walk = (arr, parent, basePath, container) => {
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < arr.length; i++) {
        const r = findNode(arr[i], id, { parent, index: i, path: basePath + "[" + i + "]", container: container || parent });
        if (r) return r;
      }
      return null;
    };
    let r;
    if (Array.isArray(root.children)) { r = walk(root.children, root, ctx.path + ".children", root); if (r) return r; }
    if (Array.isArray(root.pages)) {
      for (let pi = 0; pi < root.pages.length; pi++) {
        const pg = root.pages[pi];
        r = findNode(pg, id, { parent: root, index: pi, path: ctx.path + ".pages[" + pi + "]", container: root });
        if (r) return r;
        if (Array.isArray(pg.children)) { r = walk(pg.children, pg, ctx.path + ".pages[" + pi + "].children", pg); if (r) return r; }
      }
    }
    // 视图根的 elements（基础层）与切片 patches[].elements（扩展层）
    if (Array.isArray(root.elements)) { r = walk(root.elements, root, ctx.path + ".elements", root); if (r) return r; }
    if (Array.isArray(root.patches)) {
      for (let pk = 0; pk < root.patches.length; pk++) {
        const pch = root.patches[pk];
        // patch 自身也可作为落点父容器（切片层「新组件落入 patch.elements」）
        if (pch._id === id) return { node: pch, parent: root, index: pk, path: ctx.path + ".patches[" + pk + "]", container: root };
        if (Array.isArray(pch.elements)) { r = walk(pch.elements, pch, ctx.path + ".patches[" + pk + "].elements", pch); if (r) return r; }
      }
    }
    return null;
  }

  // 在 state 中按 id 查找（从每个 view 根开始）
  function locate(state, id) {
    for (const b of (state.bindings || [])) {
      for (const v of (b.views || [])) {
        const r = findNode(v, id, { parent: null, index: -1, path: "", container: null });
        if (r) return Object.assign({ binding: b, view: v }, r);
      }
    }
    return null;
  }

  // 「footer 恒在末尾」不变量：插入前若末尾是 footer，插到它之前
  function appendBeforeFooter(arr, obj) {
    if (!Array.isArray(arr)) return false;
    const last = arr[arr.length - 1];
    if (last && last.kind === "footer") arr.splice(arr.length - 1, 0, obj);
    else arr.push(obj);
    return true;
  }
  function insertChild(state, parentId, index, node) {
    injectIds(node);
    const loc = locate(state, parentId);
    if (!loc) return false;
    const p = loc.node;
    let arr;
    // notebook：落进「当前激活页」的 children
    if (p.kind === "notebook") {
      const pages = p.pages || (p.pages = []);
      const pi = (state._notebookActive && state._notebookActive[p._id] != null) ? state._notebookActive[p._id] : 0;
      const page = pages[pi] || (pages[pi] = { string: "页 " + (pi + 1), children: [] });
      if (!page.children) page.children = [];
      arr = page.children;
    } else if (p.kind === "page") {
      if (!p.children) p.children = [];
      arr = p.children;
    } else if (!p.kind && p.elements) {
      // 视图根（无 kind，但持有 elements 数组）：落进根 elements，遵守 footer 末尾不变量
      arr = p.elements || (p.elements = []);
    } else {
      arr = p.children || (p.children = []);
    }
    if (index == null || index >= arr.length) return appendBeforeFooter(arr, node);
    if (arr[index] && arr[index].kind === "footer") return appendBeforeFooter(arr, node);
    arr.splice(index, 0, node);
    return true;
  }
  function removeNode(state, id) {
    const loc = locate(state, id);
    if (!loc || !loc.parent) return false;
    const p = loc.parent;
    // 节点可能位于四种数组里：容器 children、notebook pages、视图根 elements、
    // 切片 patch.elements。用引用比对找到真正持有它的数组，避免「删根元素无效」。
    const candidates = [p.children, p.pages, p.elements];
    for (const arr of candidates) {
      if (!Array.isArray(arr)) continue;
      const i = arr.indexOf(loc.node);
      if (i >= 0) { arr.splice(i, 1); return true; }
    }
    if (Array.isArray(p.patches)) {
      for (const pch of p.patches) {
        if (!Array.isArray(pch.elements)) continue;
        const i = pch.elements.indexOf(loc.node);
        if (i >= 0) { pch.elements.splice(i, 1); return true; }
      }
    }
    return false;
  }
  function updateNode(state, id, patch) {
    const loc = locate(state, id);
    if (!loc) return false;
    Object.assign(loc.node, patch);
    return true;
  }
  function getChildren(loc) {
    if (!loc || !loc.node) return [];
    const n = loc.node;
    if (n.kind === "notebook") {
      const pages = n.pages || [];
      const pi = 0; // 调用方用 state._notebookActive 自行选择；此处返回第一页 children 占位
      return pages.length ? (pages[pi].children || []) : [];
    }
    return n.children || [];
  }

  // ── 定位铁律：只有 @name 是稳定且唯一的定位键（与后端 PATCH_XPATH_UNSTABLE 同步）──
  const XPATH_KINDS = new Set(["field", "filter", "button", "group", "div", "label",
    "separator", "page", "notebook", "header", "footer", "subview"]);
  function xpathForElement(e) {
    if (!e || !e.kind || !e.name || !XPATH_KINDS.has(e.kind)) return null;
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    return "//" + e.kind + "[@name=" + q(e.name) + "]";
  }
  const UNSTABLE_XPATH = /@\s*(?:string|for)\b/i;
  function targetName(xpath) {
    if (!xpath) return null;
    const m = String(xpath).match(/@name\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  }
  function fieldOf(modelDef, name) { return modelDef ? modelDef.fields.find((f) => f.name === name) || null : null; }
  function widgetSuggestions(type) { return WIDGETS[type] || []; }
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

  // ── 校验（lean，与后端 dsl_validate 同结论）──
  function customTypeIds(spec) { return (spec.viewTypes || []).map((t) => t.id).filter(Boolean); }
  function isCustomVType(spec, vt) { return vt === "custom" || customTypeIds(spec).indexOf(vt) >= 0; }
  function viewTypeDef(spec, id) { return (spec.viewTypes || []).find((d) => d.id === id) || null; }
  function viewElementDef(spec, id) { return (spec.viewElements || []).find((d) => d.id === id) || null; }
  function isExtension(v) { return !!v && (v.mode || "primary") === "extension"; }
  function isExternalInherit(ref) { return typeof ref === "string" && ref.indexOf(".") >= 0; }

  function validateElements(spec, arr, basePath, modelDef, errs) {
    (arr || []).forEach((e, k) => {
      const eid = basePath + "[" + k + "]";
      if (!e.kind) { errs.push(eid + ": 缺 kind"); return; }
      const def = KIND_DEFS[e.kind]; if (!def) { errs.push(eid + ": 未知 kind '" + e.kind + "'"); return; }
      (def.req || []).forEach((r) => { if (e[r] === undefined || e[r] === "" || e[r] === null) errs.push(eid + " (" + e.kind + ") 缺必填 '" + r + "'"); });
      if (e.kind === "customElement") {
        const d = viewElementDef(spec, e.ref);
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
      if (def.children && e.children && e.children.length) validateElements(spec, e.children, eid + ".children", modelDef, errs);
    });
  }
  function validateStructure(elements, basePath, viewType, errs) {
    STRUCTURE_KINDS.forEach((kind) => {
      const pos = [];
      (elements || []).forEach((e, i) => { if (e && e.kind === kind) pos.push(i); });
      if (pos.length > 1) errs.push(basePath + ": 出现 " + pos.length + " 个 " + kind + "（arch 最多允许一个）");
      if (pos.length && STRUCTURE_SCOPE[kind].indexOf(viewType) < 0)
        errs.push(basePath + ": " + kind + " 不适用于 viewType=" + viewType + "（允许 " + STRUCTURE_SCOPE[kind].join(" / ") + "）");
      pos.forEach((i) => {
        const want = kind === "header" ? 0 : elements.length - 1;
        if (i !== want) errs.push(basePath + "[" + i + "]: " + kind + " 必须是根 elements 的" + (kind === "header" ? "首元素" : "末尾元素"));
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
  function leanValidate(spec) {
    const errs = [];
    if (!spec.module) errs.push("根节点缺少 module");
    if (!Array.isArray(spec.bindings) || !spec.bindings.length) errs.push("bindings 必须非空");
    const reservedTypes = new Set(STANDARD_TYPES.concat(["custom"]));
    const tIds = new Set(), eDefs = new Set();
    (spec.viewTypes || []).forEach((t, i) => {
      const p = "viewTypes[" + i + "]";
      if (!t.id) errs.push(p + ": 缺 id（类型键）");
      else if (tIds.has(t.id)) errs.push(p + ": id '" + t.id + "' 重复");
      else if (reservedTypes.has(t.id)) errs.push(p + ": id '" + t.id + "' 与标准/兼容类型同名");
      if (t.id) tIds.add(t.id);
    });
    (spec.viewElements || []).forEach((d, i) => {
      const p = "viewElements[" + i + "]";
      if (!d.id) errs.push(p + ": 缺 id（引用名）");
      else if (eDefs.has(d.id)) errs.push(p + ": id '" + d.id + "' 重复");
      else if (KIND_DEFS[d.id]) errs.push(p + ": id '" + d.id + "' 与内置 kind 同名");
      if (d.id) eDefs.add(d.id);
      (d.props || []).forEach((q, j) => { if (!q || !q.name) errs.push(p + ".props[" + j + "]: 缺 name"); });
    });
    spec.bindings.forEach((b, i) => {
      if (b.viewType && !reservedTypes.has(b.viewType) && !tIds.has(b.viewType))
        errs.push("bindings[" + i + "]: viewType '" + b.viewType + "' 未在 viewTypes[] 注册");
      (b.views || []).forEach((v, j) => {
        if (v.viewType && !reservedTypes.has(v.viewType) && !tIds.has(v.viewType))
          errs.push("bindings[" + i + "].views[" + j + "]: viewType 未在 viewTypes[] 注册");
        if (isExtension(v) && (b.viewType === "custom" || tIds.has(b.viewType) || b.custom))
          errs.push("bindings[" + i + "].views[" + j + "]: 自定义视图类型不支持切片 inherit（后端 B 不预合并）");
      });
    });
    (spec.compositions || []).forEach((c, i) => {
      (c.views || []).forEach((r, j) => {
        if (r.viewType && !reservedTypes.has(r.viewType) && !tIds.has(r.viewType))
          errs.push("compositions[" + i + "].views[" + j + "]: viewType 未在 viewTypes[] 注册");
      });
    });
    spec.bindings.forEach((b, i) => {
      const bid = "bindings[" + i + "]"; if (!b.model) errs.push(bid + ": 缺 model"); if (!b.viewType) errs.push(bid + ": 缺 viewType");
      const modelDef = spec._modelRegistry && spec._modelRegistry[b.model] || null;
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
          validateElements(spec, p.elements || [], pid + ".elements", modelDef, errs);
          (p.elements || []).forEach((e, ei) => {
            if (e && STRUCTURE_SCOPE[e.kind] && STRUCTURE_SCOPE[e.kind].indexOf(b.viewType) < 0)
              errs.push(pid + ".elements[" + ei + "]: " + e.kind + " 不适用于 viewType=" + b.viewType);
          });
        });
        validateElements(spec, v.elements || [], vid + ".elements", modelDef, errs);
        if (!isExtension(v)) validateStructure(v.elements || [], vid + ".elements", b.viewType, errs);
      });
    });
    (spec.compositions || []).forEach((c, i) => { if (!c.model) errs.push("compositions[" + i + "]: 缺 model"); if (!Array.isArray(c.views) || !c.views.length) errs.push("compositions[" + i + "]: 至少一个 view"); });
    (spec.menus || []).forEach((m, i) => { if (!m.id) errs.push("menus[" + i + "]: 缺 id"); if (!m.name) errs.push("menus[" + i + "]: 缺 name"); });
    (spec.actions || []).forEach((a, i) => {
      const aid = "actions[" + i + "]";
      if (!a.id) errs.push(aid + ": 缺 id");
      if (a.type === "url" && !a.url) errs.push(aid + ": type=url 缺 url");
      if (a.type === "server" && !a.model) errs.push(aid + ": type=server 缺 model");
      if (a.type === "client" && !a.tag) errs.push(aid + ": type=client 缺 tag");
    });
    return errs;
  }

  // ── 序列化 ──
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function attrsOf(e) {
    const skip = new Set(["kind", "children", "pages", "extra", "_i", "_id"]);
    const out = [];
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
  function customElementAttrs(spec, e) {
    const skip = new Set(["kind", "children", "pages", "extra", "_i", "_id", "ref", "props"]);
    const out = [];
    for (const k in e) {
      if (skip.has(k) || e[k] === "" || e[k] == null) continue;
      out.push(k + '="' + esc(e[k]) + '"');
    }
    for (const k in (e.props || {})) out.push(k + '="' + esc(e.props[k]) + '"');
    return out.join(" ");
  }
  function elemToXml(spec, e, depth) {
    const pad = "  ".repeat(depth);
    if (e.kind === "notebook") {
      const inner = (e.pages || []).map((pg) => {
        const ppad = "  ".repeat(depth + 1);
        const head = ppad + '<page string="' + esc(pg.string || "") + '">';
        const kids = (pg.children || []).map((c) => elemToXml(spec, c, depth + 2)).join("\n");
        return head + (kids ? "\n" + kids + "\n" + ppad : "") + "</page>";
      }).join("\n");
      return pad + "<notebook>" + (inner ? "\n" + inner + "\n" + pad : "") + "</notebook>";
    }
    const a = e.kind === "customElement" ? customElementAttrs(spec, e) : attrsOf(e);
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
        const d = viewElementDef(spec, e.ref);
        open = "<" + esc((d && d.tag) || e.ref || "customElement") + (a ? " " + a : "") + "/>";
        selfClose = true; break;
      }
      case "raw": return pad + "<!-- raw (" + esc(e.reason) + ") -->\n" + pad + (e.qweb || "");
      default: open = "<" + esc(e.kind) + (a ? " " + a : "") + ">"; close = "</" + esc(e.kind) + ">";
    }
    if (def.children && e.children && e.children.length) inner = "\n" + e.children.map((c) => elemToXml(spec, c, depth + 1)).join("\n") + "\n" + pad;
    if (selfClose) return pad + open; return pad + open + inner + close;
  }
  function buildArch(spec) {
    const lines = [];
    spec.bindings.forEach((b) => { (b.views || []).forEach((v) => {
      const mode = v.mode || "primary";
      if (isCustomVType(spec, b.viewType) && mode === "primary")
        lines.push("<!-- 自定义 view type '" + esc(b.viewType) + "' → 后端 B 生成 OWL 三件套 -->");
      const rootTag = b.viewType === "list" || b.viewType === "tree" ? "tree" : b.viewType;
      if (mode === "extension") {
        lines.push("<!-- 切片 " + esc(v.id) + " → inherit: " + esc(v.inherit || "") + " -->");
        lines.push("<data>");
        (v.patches || []).forEach((p) => {
          const pos = p.position || "after";
          lines.push('  <xpath expr="' + esc(p.xpath || "") + '" position="' + esc(pos) + '">');
          if (pos === "attributes") {
            (p.attrs || []).forEach((at) => lines.push('    <attribute name="' + esc(at.name || "") + '">' + esc(at.value != null ? at.value : "") + "</attribute>"));
          } else {
            (p.elements || []).forEach((e) => lines.push(elemToXml(spec, e, 2)));
          }
          lines.push("  </xpath>");
        });
        lines.push("</data>");
        return;
      }
      lines.push("<" + rootTag + ' id="' + esc(v.id) + '">');
      (v.elements || []).forEach((e) => lines.push(elemToXml(spec, e, 1)));
      lines.push("</" + rootTag + ">");
    }); });
    return lines.join("\n");
  }
  // 导出：剥离内部 _id / _i / _notebookActive
  function toCleanSpec(spec) {
    const clone = JSON.parse(JSON.stringify(spec, (k, v) =>
      (k.startsWith("_") ? undefined : v)));
    return clone;
  }

  // ── 模型注册表（设计器上下文，不写 DSL）──
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
  // 默认初始 spec（与 designer/ 原型等价，便于对比产物）
  function defaultSpec() {
    return {
      module: "dsl_gen",
      viewTypes: [], viewElements: [],
      bindings: [{
        model: "sale.order", viewType: "form",
        views: [
          { id: "base", mode: "primary", elements: [
            { kind: "header", children: [
              { kind: "button", name: "action_confirm", string: "确认订单", type: "object" },
              { kind: "button", name: "action_quotation_send", string: "发送报价", type: "object" },
              { kind: "field", name: "state", widget: "statusbar" },
            ]},
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
          ]},
          { id: "slice_hide_amount", name: "隐藏金额（切片）", mode: "extension", inherit: "base",
            patches: [
              { xpath: "//field[@name='amount_total']", position: "attributes", attrs: [{ name: "invisible", value: "1" }] },
              { xpath: "//field[@name='note']", position: "after", elements: [{ kind: "field", name: "client_order_ref", string: "客户单号" }] },
            ] },
        ],
      }],
      compositions: [{ kind: "act_window", id: "action_sale", model: "sale.order", name: "销售订单", views: [{ viewType: "form" }, { viewType: "list" }], target: "current" }],
      actions: [],
      menus: [{ id: "sale_root", name: "销售" }, { id: "sale_menu", name: "销售订单", action: "action_sale", parent: "sale_root" }],
      _modelRegistry: {},
    };
  }

  global.DslCore = {
    KIND_DEFS, KINDS, PATCH_POSITIONS, VIEW_TYPES, CONTAINER_KINDS, STANDARD_TYPES,
    STRUCTURE_KINDS, STRUCTURE_SCOPE, WIDGETS,
    XPATH_KINDS, UNSTABLE_XPATH,
    injectIds, injectStateIds, freshId,
    findNode, locate, insertChild, removeNode, updateNode, getChildren, appendBeforeFooter,
    xpathForElement, targetName, fieldOf, widgetSuggestions, describeElem, posTextShort, defaultPatchElement,
    customTypeIds, isCustomVType, viewTypeDef, viewElementDef, isExtension, isExternalInherit,
    validateElements, validateStructure, leanValidate,
    attrsOf, customElementAttrs, elemToXml, buildArch, toCleanSpec,
    SAMPLE_MODELS, defaultSpec,
  };
})(window);
