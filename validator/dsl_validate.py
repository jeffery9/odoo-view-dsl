#!/usr/bin/env python3
"""
DSL IR 级静态校验器（规范 docs/dsl_qweb_owl_specification.md §6）
===============================================================

在「降低为 arch → RNG 终审」之前，对**四层 DSL 模型本身**做廉价、自包含的结构校验：
  - 元素按视图类型作用域（§6.5）：notebook/page 仅 form；filter/searchpanel 仅 search；groupby/control 仅 list；header 限 form/list；footer 仅 form。
  - 结构位置（§6.5）：header/footer 只能是视图根 elements 的首/末元素，各最多一个，不得嵌套。
  - raw 逃逸舱硬约束（§6.4）：每个 raw 必带 reason；标准视图 raw 数应 = 0（seam 告警）。
  - extra 键对照 RNG（§3.2/§6.5）：field.extra 的每个键必须属于 Odoo common.rng 的 field 属性集（拼写漂移检测，如 decoation-danger）。
  - inherit 链结构（§4.1/§6.6）：层栈收敛到唯一 primary（或外部基视图）、无环、目标存在、层序单调。
  - 切片层（§4.1/§6.6）：patch 的 position/载荷互斥、mode 互斥；`patches[].elements`
    与主视图 `elements` 走**同一套**元素级校验，切片不是校验盲区。

需 Odoo 运行时的检查（字段是否属 model、xpath 目标是否存在）本模块**不执行**，仅以 info 标注，
交由 RNG 终审 + Odoo 运行时兜底（见 rng_validate.py / 规范 §6.5）。

依赖：rng_validate.allowed_field_attributes（同目录）。
用法：
  python3 dsl_validate.py --binding-file binding.json
  python3 dsl_validate.py --view-file view.json
  cat binding.json | python3 dsl_validate.py --json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Optional

# 同目录导入 rng_validate（复用 RNG 属性集抽取）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rng_validate import allowed_field_attributes, DEFAULT_RNG_DIR  # noqa: E402

# ── 元素作用域表（规范 §6.5）──
# 键未列举的元素视为「共享」，所有视图类型均允许。
ELEMENT_VIEW_SCOPE = {
    "notebook": {"form"},
    "page": {"form"},
    "filter": {"search"},
    "searchpanel": {"search"},
    "groupby": {"list"},
    "control": {"list"},
    "header": {"form", "list"},
    "footer": {"form"},
}

# 生成器支持的全部元素种类（DSL IR 层已知集合）。
# 与 oview/qweb_ir.py 中的 KNOWN_KINDS 保持同步：生成器与校验器各自持有副本
# （校验器须独立可运行，不从 oview 包 import）。变更时需同步两处。
KNOWN_KINDS = {
    "field", "group", "notebook", "page", "button", "separator", "label",
    "div", "header", "footer", "filter", "subview", "component", "if", "foreach",
    "set", "slot", "dynamicAttr", "call", "raw", "customElement",
}

# 结构条元素：arch 顺序敏感，只能出现在视图根 elements 的首 / 末（§6.5）
STRUCTURE_KINDS = ("header", "footer")

# 切片（extension view）patch 的合法 position（与 schema/$defs/Patch 一致）
PATCH_POSITIONS = {"inside", "after", "before", "replace", "attributes"}
# 标准视图类型（决定 raw seam 告警级别 / 自定义类型注册表的保留字）。
# 与 oview/model.py 的 STANDARD_TYPES 保持同步（校验器独立可运行，不 import oview）。
STANDARD_VIEW_TYPES = {"form", "list", "tree", "search", "graph", "pivot",
                       "calendar", "activity", "dashboard", "kanban",
                       "gantt", "cohort", "map"}
# 兼容字面的旧自定义类型名（未注册时由后端 B 合成隐式注册项）
LEGACY_CUSTOM_TYPE = "custom"

# 定位铁律：只有 @name 是稳定且唯一的定位键。string 是可翻译、可重复的显示标签
# （两个 <group string="主要信息"> 完全合法），label/@for 亦可重复，均不得用于 xpath。
_UNSTABLE_XPATH_RE = re.compile(r"@\s*(?:string|for)\b", re.IGNORECASE)

# 承载子元素的字段名（用于递归遍历）
_CHILD_KEYS = ("children", "elements", "fallback", "block")
_PAGE_CHILD_KEY = "pages"  # notebook.pages[].children


@dataclass
class Issue:
    severity: str            # "error" | "warning" | "info"
    code: str
    message: str
    view_id: Optional[str] = None
    element: Optional[str] = None


def _walk_elements(elements):
    """递归产出所有元素 dict（含 notebook.pages、各 children/fallback/block）。"""
    for el in elements or []:
        if not isinstance(el, dict):
            continue
        yield el
        # notebook → pages → children
        for pg in el.get(_PAGE_CHILD_KEY, []) or []:
            if isinstance(pg, dict):
                yield from _walk_elements(pg.get("children", []))
        # 通用子元素容器
        for key in _CHILD_KEYS:
            val = el.get(key)
            if isinstance(val, list):
                yield from _walk_elements(val)
            elif isinstance(val, dict):
                # field.children / component 等可能是单元素
                yield from _walk_elements([val])


def check_element_scope(view_type: str, elements, view_id: Optional[str]) -> list[Issue]:
    out: list[Issue] = []
    for el in _walk_elements(elements):
        kind = el.get("kind")
        if kind is None:
            out.append(Issue("error", "ELEMENT_NO_KIND",
                             f"元素缺少 kind 字段: {el!r}", view_id=view_id))
            continue
        scope = ELEMENT_VIEW_SCOPE.get(kind)
        if scope is not None and view_type not in scope:
            out.append(Issue(
                "error", "ELEMENT_SCOPE_VIOLATION",
                f"元素 <{kind}> 仅允许于 {sorted(scope)}，但出现在 {view_type} 视图",
                view_id=view_id, element=kind,
            ))
    return out


def check_unknown_kind(view_type: str, elements, view_id: Optional[str]) -> list[Issue]:
    """未知元素种类必须被拦截（B2）：作者把 `field` 拼成 `fild` 时，
    整条管线曾 0 error 通过却产出无效视图。这里确保「不静默降级」铁律在 IR 层生效。
    """
    out: list[Issue] = []
    for el in _walk_elements(elements):
        kind = el.get("kind")
        if kind is None:
            continue  # ELEMENT_NO_KIND 已由 check_element_scope 报告
        if kind not in KNOWN_KINDS:
            out.append(Issue(
                "error", "ELEMENT_UNKNOWN_KIND",
                f"未知元素种类 {kind!r}：不在 DSL 元素词汇中（可能拼写漂移，如 field→fild），"
                f"非法 DSL 必须在此被拦截而非静默通过",
                view_id=view_id, element=kind,
            ))
    return out


def check_raw_seam(view_type: str, elements, view_id: Optional[str],
                   standard: bool) -> list[Issue]:
    """每个 raw 必带 reason；标准视图 raw>0 报 seam 告警（§6.4）。"""
    out: list[Issue] = []
    raw_count = 0
    for el in _walk_elements(elements):
        if el.get("kind") == "raw":
            raw_count += 1
            if not el.get("reason"):
                out.append(Issue(
                    "error", "RAW_MISSING_REASON",
                    "raw 逃逸舱必须带 reason（说明为何 DSL 无法表达）",
                    view_id=view_id, element="raw",
                ))
    if raw_count > 0:
        # 标准视图目标 raw=0；自定义视图允许极端场景，降为 info
        sev = "warning" if standard else "info"
        out.append(Issue(
            sev, "RAW_SEAM",
            f"检测到 {raw_count} 处 raw 逃逸舱（{'标准' if standard else '自定义'}视图目标 raw=0）",
            view_id=view_id, element="raw",
        ))
    return out


def check_extra_keys(view_type: str, elements, view_id: Optional[str],
                     rng_dir: Optional[str]) -> list[Issue]:
    """field.extra 的每个键必须属于 Odoo field 属性集（§3.2/§6.5）。"""
    out: list[Issue] = []
    allowed = allowed_field_attributes(rng_dir)
    if not allowed:
        out.append(Issue(
            "info", "EXTRA_KEYS_UNCHECKED",
            "common.rng 不可用，跳过 extra 键校验",
            view_id=view_id,
        ))
        return out
    for el in _walk_elements(elements):
        if el.get("kind") == "field":
            extra = el.get("extra") or {}
            for key in extra:
                if key not in allowed:
                    out.append(Issue(
                        "error", "EXTRA_KEY_UNKNOWN",
                        f"field.extra 键 {key!r} 不在 Odoo field 属性集中（可能拼写漂移）",
                        view_id=view_id, element="field",
                    ))
    return out


def _descendants(el: dict):
    """产出某个根元素的全部后代（不含自身），用于结构条嵌套检查。"""
    out = []
    for key in _CHILD_KEYS:
        val = el.get(key)
        if isinstance(val, list):
            out.extend(_walk_elements(val))
        elif isinstance(val, dict):
            out.extend(_walk_elements([val]))
    for pg in el.get(_PAGE_CHILD_KEY, []) or []:
        if isinstance(pg, dict):
            out.extend(_walk_elements(pg.get("children", [])))
    return out


def check_structure_elements(elements, view_id: Optional[str] = None) -> list[Issue]:
    """header/footer 的 arch 顺序与嵌套约束（规范 §6.5）。

    Odoo 的 form_view.rng 要求 <header> 在 <form> 内最前、<footer> 在最后，
    且各最多一个。DSL 用「视图根 elements」承载 form 的直接子节点，故此处
    按数组位置校验，避免生成 Odoo 会拒绝的 arch。

    切片 patches[].elements 不参与本检查：它们由 xpath/position 决定注入位置。
    """
    out: list[Issue] = []
    if not isinstance(elements, list):
        return out
    for kind in STRUCTURE_KINDS:
        pos = [i for i, e in enumerate(elements)
               if isinstance(e, dict) and e.get("kind") == kind]
        if len(pos) > 1:
            out.append(Issue(
                "error", "ELEMENT_STRUCTURE",
                f"视图根 elements 出现 {len(pos)} 个 <{kind}>（索引 {pos}）：arch 最多允许一个",
                view_id=view_id,
            ))
        for i in pos:
            want = 0 if kind == "header" else len(elements) - 1
            if i != want:
                where = "首元素（索引 0）" if kind == "header" else "末尾元素"
                out.append(Issue(
                    "error", "ELEMENT_STRUCTURE",
                    f"elements[{i}] 的 <{kind}> 必须位于根 elements 的{where}；"
                    f"当前顺序会产出 Odoo RNG 拒绝的 arch",
                    view_id=view_id,
                ))
    for i, e in enumerate(elements):
        if not isinstance(e, dict):
            continue
        for d in _descendants(e):
            if d.get("kind") in STRUCTURE_KINDS:
                out.append(Issue(
                    "error", "ELEMENT_STRUCTURE",
                    f"elements[{i}] 的后代中嵌套了 <{d['kind']}>："
                    f"header/footer 只能作为视图根元素，不能放进 group/notebook/其它容器",
                    view_id=view_id,
                ))
    return out


def _is_external_ref(ref) -> bool:
    """含 '.' 的 inherit 视为字面外部 xml_id（跨模块基视图），不做本 binding 存在性检查。"""
    return isinstance(ref, str) and "." in ref


def _prefix(issues: list[Issue], prefix: str) -> list[Issue]:
    """给 issue 消息加上 patch 定位前缀，便于定位到具体切片修改。"""
    for it in issues:
        it.message = prefix + it.message
    return issues


def check_patches(view: dict, view_type: str, view_id: Optional[str],
                  rng_dir: Optional[str] = None) -> list[Issue]:
    """切片层（extension view）校验（§4.1 / §6.6）。

    两个核心目标：
    1. **切片不是校验盲区**：`patches[].elements` 与主视图 `elements` 走完全相同的
       元素级检查（未知 kind / 类型作用域 / raw reason / extra 键），否则作者把
       `field` 拼成 `fild` 注入切片时，整条管线会 0 error 通过。
    2. **不静默丢数据**：mode 与其内容互斥（primary 不带 patches/inherit，
       extension 不带 elements），position 与载荷互斥。
    """
    out: list[Issue] = []
    mode = view.get("mode", "primary")
    patches = view.get("patches") or []
    elements = view.get("elements") or []

    if mode == "primary":
        if patches:
            out.append(Issue(
                "error", "PATCH_ON_PRIMARY",
                f"primary 基视图 {view_id!r} 带 patches：patches 只属于 extension 切片，生成器会忽略",
                view_id=view_id,
            ))
        if view.get("inherit"):
            out.append(Issue(
                "error", "PRIMARY_HAS_INHERIT",
                f"primary 基视图 {view_id!r} 不应带 inherit（inherit 只属于 extension 切片）",
                view_id=view_id,
            ))
    else:
        if elements:
            out.append(Issue(
                "error", "EXTENSION_HAS_ELEMENTS",
                f"切片 {view_id!r} 带 elements：生成器只消费 patches，这些元素会被静默丢弃；"
                f"请把内容改写为 patches[].elements",
                view_id=view_id,
            ))
        if not view.get("inherit"):
            out.append(Issue(
                "error", "INHERIT_REQUIRED",
                f"切片 {view_id!r} 缺少 inherit（本 binding 层 id 或含 '.' 的外部 xml_id）",
                view_id=view_id,
            ))
        elif _is_external_ref(view["inherit"]):
            out.append(Issue(
                "info", "EXTERNAL_BASE_VIEW",
                f"切片 {view_id!r} 继承外部基视图 {view['inherit']!r}：其存在性需 Odoo 运行时核验",
                view_id=view_id,
            ))

    standard = view_type in STANDARD_VIEW_TYPES
    for i, p in enumerate(patches):
        if not isinstance(p, dict):
            out.append(Issue("error", "PATCH_NOT_OBJECT",
                             f"patches[{i}] 必须是对象，实际为 {type(p).__name__}", view_id=view_id))
            continue
        tag = f"patches[{i}]: "
        pos = p.get("position")
        if pos not in PATCH_POSITIONS:
            out.append(Issue(
                "error", "PATCH_POSITION_INVALID",
                tag + f"position={pos!r} 不在 {sorted(PATCH_POSITIONS)} 中",
                view_id=view_id,
            ))
        xpath = p.get("xpath")
        if not (isinstance(xpath, str) and xpath.strip()):
            out.append(Issue("error", "PATCH_XPATH_EMPTY",
                             tag + "xpath 为空，无法定位父 arch 节点", view_id=view_id))
        elif _UNSTABLE_XPATH_RE.search(xpath):
            out.append(Issue(
                "error", "PATCH_XPATH_UNSTABLE",
                tag + f"xpath {xpath!r} 使用 @string/@for 定位：显示标签可翻译且可重复，"
                      f"可能命中多个节点；只有 @name 是稳定唯一键。"
                      f"请改用 //field[@name='...']，或以其为锚点（如 //field[@name='x']/..）",
                view_id=view_id,
            ))
        els = p.get("elements") or []
        attrs = p.get("attrs") or []

        if pos == "attributes":
            if not attrs:
                out.append(Issue("error", "PATCH_ATTRIBUTES_EMPTY",
                                 tag + "position=attributes 必须提供至少一条 attrs", view_id=view_id))
            if els:
                out.append(Issue("error", "PATCH_ELEMENTS_ON_ATTRIBUTES",
                                 tag + "position=attributes 不接受 elements（属性修改只走 attrs）",
                                 view_id=view_id))
            for j, a in enumerate(attrs):
                if not isinstance(a, dict) or not a.get("name"):
                    out.append(Issue("error", "PATCH_ATTR_NO_NAME",
                                     tag + f"attrs[{j}] 缺少属性名 name", view_id=view_id))
        else:
            if attrs:
                out.append(Issue("error", "PATCH_ATTRS_ON_NON_ATTRIBUTES",
                                 tag + f"position={pos!r} 不接受 attrs（插入内容只走 elements）",
                                 view_id=view_id))
            if not els and pos != "replace":
                out.append(Issue("warning", "PATCH_EMPTY",
                                 tag + f"position={pos!r} 既无 elements 也无有效载荷，将生成空 xpath",
                                 view_id=view_id))

        # 切片内元素 = 一等元素：复用主视图的四项元素级检查
        if els:
            out += _prefix(check_unknown_kind(view_type, els, view_id), tag)
            if view_type:  # 作用域 / raw / extra 三项依赖已解析的视图类型
                out += _prefix(check_element_scope(view_type, els, view_id), tag)
                out += _prefix(check_raw_seam(view_type, els, view_id, standard), tag)
                out += _prefix(check_extra_keys(view_type, els, view_id, rng_dir), tag)
    return out


def check_inherit_chain(views: list[dict]) -> list[Issue]:
    """一组 View 的 inherit 结构校验（§4.1 / §6）：目标存在、收敛唯一 primary、无环、层序单调。

    外部基视图（含 '.' 的字面 xml_id）不参与本 binding 的存在性/环检测；
    若整个 binding 全是继承外部基视图的切片，则允许没有 primary（纯继承模块）。
    """
    out: list[Issue] = []
    by_id = {v.get("id"): v for v in views if v.get("id")}
    if len(by_id) < len(views):
        out.append(Issue("error", "VIEW_ID_DUPLICATE", "存在重复或缺失的视图 id"))

    # 目标存在性（外部引用跳过）
    for v in views:
        inh = v.get("inherit")
        if inh and not _is_external_ref(inh) and inh not in by_id:
            out.append(Issue(
                "error", "INHERIT_TARGET_MISSING",
                f"视图 {v.get('id')!r} 的 inherit 目标 {inh!r} 不存在"
                f"（既非本 binding 内层 id，也非含 '.' 的外部 xml_id）",
                view_id=v.get("id"),
            ))

    # 层序单调：切片应 inherit 前序层，否则合并顺序与层栈声明不一致
    index_of = {v.get("id"): i for i, v in enumerate(views) if v.get("id")}
    for i, v in enumerate(views):
        inh = v.get("inherit")
        if inh and not _is_external_ref(inh) and inh in index_of and index_of[inh] >= i:
            out.append(Issue(
                "warning", "INHERIT_FORWARD_REF",
                f"切片 {v.get('id')!r}（层 {i}）inherit 了非前序层 {inh!r}（层 {index_of[inh]}）；"
                f"层栈要求 inherit 指向索引更小的层",
                view_id=v.get("id"),
            ))

    # primary 计数
    primaries = [v for v in views if v.get("mode") != "extension"]
    external_roots = {v.get("inherit") for v in views
                      if v.get("mode") == "extension" and _is_external_ref(v.get("inherit"))}
    if not primaries:
        if views and external_roots and all(
            v.get("mode") == "extension" and _is_external_ref(v.get("inherit")) for v in views
        ):
            out.append(Issue(
                "info", "EXTERNAL_BASE_VIEW",
                f"该 binding 无 primary：全部切片继承外部基视图 {sorted(external_roots)}，"
                f"属合法的纯继承模块；外部基视图存在性需 Odoo 运行时核验",
            ))
        else:
            out.append(Issue("error", "NO_PRIMARY", "该 ViewTypeBinding 无任何 primary 基视图"))
    elif len(primaries) > 1:
        out.append(Issue(
            "error", "MULTIPLE_PRIMARY",
            f"同一 (model,type) 下存在多个 primary: {[v.get('id') for v in primaries]}",
        ))

    # 环检测（DFS）：外部引用为链的终点，不入栈
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {vid: WHITE for vid in by_id}

    def dfs(vid, stack):
        color[vid] = GRAY
        v = by_id[vid]
        inh = v.get("inherit")
        if inh and not _is_external_ref(inh):
            if inh not in by_id:
                color[vid] = BLACK
                return
            if color[inh] == GRAY:
                out.append(Issue(
                    "error", "INHERIT_CYCLE",
                    f"inherit 链成环: {' -> '.join(stack + [vid, inh])}",
                    view_id=vid,
                ))
                return
            if color[inh] == WHITE:
                dfs(inh, stack + [vid])
        color[vid] = BLACK

    for vid in by_id:
        if color[vid] == WHITE:
            dfs(vid, [])
    return out


def validate_view(view: dict, model: Optional[str] = None,
                   view_type: Optional[str] = None,
                   rng_dir: Optional[str] = None) -> list[Issue]:
    """校验单条 View。model/viewType 以**绑定层为权威**，View 缺省时回退继承。"""
    out: list[Issue] = []
    vid = view.get("id")
    # 解析 model/viewType：View 自身优先，否则继承绑定层
    resolved_model = view.get("model") or model
    resolved_vtype = view.get("viewType") or view_type
    if not resolved_model:
        out.append(Issue("error", "VIEW_NO_MODEL",
                         "View 缺少 model 绑定（View 与 ViewTypeBinding 均未提供）",
                         view_id=vid))
    if not resolved_vtype:
        out.append(Issue("error", "VIEW_NO_TYPE",
                         "View 缺少 viewType（View 与 ViewTypeBinding 均未提供）",
                         view_id=vid))
    elements = view.get("elements", [])
    # 未知种类卡控（B2）：不依赖视图类型，始终执行
    out += check_unknown_kind(resolved_vtype or "", elements, vid)
    if resolved_vtype:
        standard = resolved_vtype in STANDARD_VIEW_TYPES
        out += check_element_scope(resolved_vtype, elements, vid)
        out += check_structure_elements(elements, vid)
        out += check_raw_seam(resolved_vtype, elements, vid, standard)
        out += check_extra_keys(resolved_vtype, elements, vid, rng_dir)
    # 切片层校验（§4.1/§6.6）：patch 结构、position/载荷互斥、mode 互斥、patch 内元素级检查
    out += check_patches(view, resolved_vtype or "", vid, rng_dir)
    # 需 Odoo 环境的检查仅标注
    out.append(Issue(
        "info", "NEEDS_ODOO_ENV",
        "字段是否属 model、xpath 目标是否存在 需 Odoo 运行时核验（本模块不执行）",
        view_id=vid,
    ))
    return out


def validate_binding(binding: dict, rng_dir: Optional[str] = None) -> list[Issue]:
    out: list[Issue] = []
    model = binding.get("model")
    vtype = binding.get("viewType")
    if not model:
        out.append(Issue("error", "BINDING_NO_MODEL", "ViewTypeBinding 缺少 model"))
    if not vtype:
        out.append(Issue("error", "BINDING_NO_TYPE", "ViewTypeBinding 缺少 viewType"))
    views = binding.get("views", [])
    # 逐视图（model/viewType 从绑定层继承）
    for v in views:
        out += validate_view(v, model=model, view_type=vtype, rng_dir=rng_dir)
    # inherit 链结构（独立、跨视图）
    out += check_inherit_chain(views)
    return out


def check_menu_refs(spec: dict, rng_dir: Optional[str] = None) -> list[Issue]:
    """顶层 menus[]/actions[] 引用完整性（**不静默降级**）：

    - menu.action 必须指向：本 DSL 的 composition id、explicit action id，或含 '.' 的字面 xml_id；
    - menu.parent 必须指向：本 DSL 的 menu id，或含 '.' 的字面 xml_id。
    否则视为悬空引用并报 ERROR，避免生成指向不存在 action 的菜单。
    """
    out: list[Issue] = []
    comp_ids = {c.get("id") for c in spec.get("compositions", []) or [] if c.get("id")}
    action_ids = {a.get("id") for a in spec.get("actions", []) or [] if a.get("id")}
    menu_ids = {m.get("id") for m in spec.get("menus", []) or [] if m.get("id")}

    for m in spec.get("menus", []) or []:
        mid = m.get("id")
        ref = m.get("action")
        # 容器菜单（无 action，仅作分组父节点）是合法的 Odoo 语义，不报错
        if ref and "." not in ref and ref not in comp_ids and ref not in action_ids:
            out.append(Issue(
                "error", "MENU_ACTION_DANGLING",
                f"菜单 {mid!r} 的 action {ref!r} 未指向任何 composition id / explicit action id"
                f"（且非字面 xml_id），将生成悬空菜单",
                view_id=mid,
            ))
        parent = m.get("parent")
        if parent and "." not in parent and parent not in menu_ids:
            out.append(Issue(
                "error", "MENU_PARENT_DANGLING",
                f"菜单 {mid!r} 的 parent {parent!r} 未指向任何 menu id（且非字面 xml_id）",
                view_id=mid,
            ))
    return out


def _spec_element_lists(spec: dict):
    """产出 spec 中所有元素列表（主视图 elements + 切片 patches[].elements）。"""
    for b in spec.get("bindings", []) or []:
        for v in b.get("views", []) or []:
            if isinstance(v.get("elements"), list):
                yield v["elements"]
            for p in v.get("patches", []) or []:
                if isinstance(p.get("elements"), list):
                    yield p["elements"]


def check_registry_refs(spec: dict, rng_dir: Optional[str] = None) -> list[Issue]:
    """§6.7 自定义注册表引用完整性（**先声明后引用，不静默降级**）。

    覆盖三类自定义：viewTypes[]（自定义 view type）、viewElements[]（自定义 view element）、
    actions[].type=client（自定义客户端动作）。结构化必填/类型归 JSON Schema，本函数只管
    跨对象引用与契约：id 唯一/保留字、binding/Composition 的类型引用、customElement.ref
    与 required props、client action tag、未使用声明。
    """
    out: list[Issue] = []
    vts = spec.get("viewTypes", []) or []
    ves = spec.get("viewElements", []) or []

    # ── 1) 注册表自身：id 唯一、不得侵占内置词汇 ──
    vt_ids: set[str] = set()
    ve_by_id: dict[str, dict] = {}
    for i, t in enumerate(vts):
        tid = t.get("id")
        if not tid:
            out.append(Issue("error", "CUSTOM_TYPE_NO_ID",
                             f"viewTypes[{i}] 缺少 id（类型键）"))
        elif tid in vt_ids:
            out.append(Issue("error", "CUSTOM_TYPE_DUPLICATE",
                             f"viewTypes[{i}].id={tid!r} 重复"))
        elif tid in STANDARD_VIEW_TYPES or tid == LEGACY_CUSTOM_TYPE:
            out.append(Issue("error", "CUSTOM_TYPE_RESERVED",
                             f"viewTypes[{i}].id={tid!r} 是保留的类型名（标准视图 / 兼容字面 custom）"))
        else:
            vt_ids.add(tid)
    for i, e in enumerate(ves):
        eid = e.get("id")
        if not eid:
            out.append(Issue("error", "CUSTOM_ELEMENT_NO_ID",
                             f"viewElements[{i}] 缺少 id（引用名）"))
        elif eid in ve_by_id:
            out.append(Issue("error", "CUSTOM_ELEMENT_DUPLICATE",
                             f"viewElements[{i}].id={eid!r} 重复"))
        elif eid in KNOWN_KINDS:
            out.append(Issue("error", "CUSTOM_ELEMENT_RESERVED",
                             f"viewElements[{i}].id={eid!r} 与内置 Element kind 同名"))
        else:
            ve_by_id[eid] = e
        # prop 契约项自身合法性
        seen_props: set[str] = set()
        for j, p in enumerate(e.get("props", []) or []):
            pname = p.get("name") if isinstance(p, dict) else None
            if not pname:
                out.append(Issue("error", "CUSTOM_ELEMENT_PROP_NO_NAME",
                                 f"viewElements[{i}].props[{j}] 缺少 name"))
            elif pname in seen_props:
                out.append(Issue("error", "CUSTOM_ELEMENT_PROP_DUPLICATE",
                                 f"viewElements[{i}].props[{j}].name={pname!r} 重复"))
            else:
                seen_props.add(pname)

    vt_tags = {t.get("tag") for t in vts if t.get("tag")}
    used_types: set[str] = set()
    used_elements: set[str] = set()

    def check_type_ref(vt, where: str) -> None:
        if not vt or vt in STANDARD_VIEW_TYPES or vt == LEGACY_CUSTOM_TYPE:
            return
        if vt not in vt_ids:
            out.append(Issue("error", "CUSTOM_TYPE_UNREGISTERED",
                             f"{where} 的 viewType={vt!r} 非标准类型且未在 viewTypes[] 注册"
                             f"（避免把拼写错误当标准视图生成无效 arch）"))
        else:
            used_types.add(vt)

    # ── 2) 类型引用：binding / view 覆写 / Composition ──
    for bi, b in enumerate(spec.get("bindings", []) or []):
        check_type_ref(b.get("viewType"), f"bindings[{bi}]")
        btype = b.get("viewType")
        is_custom_binding = (btype in vt_ids or btype == LEGACY_CUSTOM_TYPE
                             or bool(b.get("custom")))
        for vi, v in enumerate(b.get("views", []) or []):
            check_type_ref(v.get("viewType"), f"bindings[{bi}].views[{vi}]")
            if is_custom_binding and (v.get("mode") == "extension" or v.get("inherit")):
                out.append(Issue(
                    "error", "CUSTOM_TYPE_INHERIT_UNSUPPORTED",
                    f"bindings[{bi}].views[{vi}] 是自定义视图类型的切片；后端 B 不预合并视图"
                    f"（合并权归 Odoo 运行时），自定义类型的 inherit 语义尚未定义，请改为单条 primary 视图",
                ))
    for ci, c in enumerate(spec.get("compositions", []) or []):
        for vi, vr in enumerate(c.get("views", []) or []):
            check_type_ref(vr.get("viewType"), f"compositions[{ci}].views[{vi}]")

    # ── 3) customElement 引用与 props 契约（含切片 patch 注入元素）──
    for els in _spec_element_lists(spec):
        for el in _walk_elements(els):
            if el.get("kind") != "customElement":
                continue
            ref = el.get("ref")
            if not ref or ref not in ve_by_id:
                out.append(Issue("error", "CUSTOM_ELEMENT_UNREGISTERED",
                                 f"customElement 的 ref={ref!r} 未命中 viewElements[] 注册项"))
                continue
            used_elements.add(ref)
            prop_defs = {p["name"]: p for p in (ve_by_id[ref].get("props") or [])
                        if isinstance(p, dict) and p.get("name")}
            given = el.get("props") or {}
            for pname, pdef in prop_defs.items():
                if (pdef.get("required") and pname not in given
                        and "default" not in pdef):
                    out.append(Issue("error", "CUSTOM_ELEMENT_PROP_MISSING",
                                     f"customElement ref={ref!r} 缺少必需 prop {pname!r}"))
            if prop_defs:
                for pname in given:
                    if pname not in prop_defs:
                        out.append(Issue("error", "CUSTOM_ELEMENT_PROP_UNKNOWN",
                                         f"customElement ref={ref!r} 传入未声明的 prop {pname!r}"))

    # ── 4) 自定义客户端动作 ──
    for i, a in enumerate(spec.get("actions", []) or []):
        if a.get("type") != "client":
            continue
        tag = a.get("tag")
        if not tag:
            out.append(Issue("error", "CUSTOM_ACTION_TAG_MISSING",
                             f"actions[{i}] type=client 缺少 tag"))
        elif tag not in vt_tags and "." not in tag:
            out.append(Issue("warning", "CUSTOM_ACTION_TAG_UNQUALIFIED",
                             f"actions[{i}].tag={tag!r} 未引用 viewTypes[].tag 且非限定名，"
                             f"建议用 'module.tag' 形式避免与其它模块冲突"))

    # ── 5) 未使用声明只告警，不阻塞 ──
    for tid in sorted(vt_ids - used_types):
        out.append(Issue("warning", "CUSTOM_TYPE_UNUSED",
                         f"viewTypes[].id={tid!r} 未被任何 binding / Composition 引用"))
    for eid in sorted(set(ve_by_id) - used_elements):
        out.append(Issue("warning", "CUSTOM_ELEMENT_UNUSED",
                         f"viewElements[].id={eid!r} 未被任何 customElement 引用"))
    return out


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="DSL IR 级静态校验器")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--binding-file", help="ViewTypeBinding JSON 文件")
    src.add_argument("--view-file", help="单个 View JSON 文件")
    src.add_argument("--json-stdin", action="store_true", help="从 stdin 读 JSON")
    parser.add_argument("--rng-dir", default=None)
    args = parser.parse_args(argv)

    if args.binding_file:
        data = json.load(open(args.binding_file, "r", encoding="utf-8"))
        issues = validate_binding(data, rng_dir=args.rng_dir)
    elif args.view_file:
        data = json.load(open(args.view_file, "r", encoding="utf-8"))
        issues = validate_view(data, rng_dir=args.rng_dir)
    else:
        data = json.load(sys.stdin)
        # 启发式：含 views 列表视为 binding
        issues = validate_binding(data, rng_dir=args.rng_dir) if "views" in data else validate_view(data, rng_dir=args.rng_dir)

    for i in issues:
        loc = f"[{i.view_id}]" if i.view_id else ""
        print(f"  - {i.severity.upper()}{loc} [{i.code}] {i.message}")
    has_err = any(i.severity == "error" for i in issues)
    return 1 if has_err else 0


if __name__ == "__main__":
    sys.exit(main())
