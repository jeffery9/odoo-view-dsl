#!/usr/bin/env python3
"""
DSL IR 级静态校验器（规范 docs/dsl_qweb_owl_specification.md §6）
===============================================================

在「降低为 arch → RNG 终审」之前，对**四层 DSL 模型本身**做廉价、自包含的结构校验：
  - 元素按视图类型作用域（§6.5）：notebook/page 仅 form；filter/searchpanel 仅 search；groupby/control 仅 list；header 限 form/list。
  - raw 逃逸舱硬约束（§6.4）：每个 raw 必带 reason；标准视图 raw 数应 = 0（seam 告警）。
  - extra 键对照 RNG（§3.2/§6.5）：field.extra 的每个键必须属于 Odoo common.rng 的 field 属性集（拼写漂移检测，如 decoation-danger）。
  - inherit 链结构（§4/§6）：一组 View 必须收敛到唯一 primary、无环、inherit 目标存在。

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
}

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


def check_inherit_chain(views: list[dict]) -> list[Issue]:
    """一组 View 的 inherit 结构校验（§4/§6）：目标存在、收敛唯一 primary、无环。"""
    out: list[Issue] = []
    by_id = {v.get("id"): v for v in views if v.get("id")}
    if len(by_id) < len(views):
        out.append(Issue("error", "VIEW_ID_DUPLICATE", "存在重复或缺失的视图 id"))

    # 目标存在性
    for v in views:
        inh = v.get("inherit")
        if inh and inh not in by_id:
            out.append(Issue(
                "error", "INHERIT_TARGET_MISSING",
                f"视图 {v.get('id')!r} 的 inherit 目标 {inh!r} 不存在",
                view_id=v.get("id"),
            ))

    # primary 计数
    primaries = [v for v in views if v.get("mode") != "extension"]
    if not primaries:
        out.append(Issue("error", "NO_PRIMARY", "该 ViewTypeBinding 无任何 primary 基视图"))
    elif len(primaries) > 1:
        out.append(Issue(
            "error", "MULTIPLE_PRIMARY",
            f"同一 (model,type) 下存在多个 primary: {[v.get('id') for v in primaries]}",
        ))

    # 环检测（DFS）
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {vid: WHITE for vid in by_id}

    def dfs(vid, stack):
        color[vid] = GRAY
        v = by_id[vid]
        inh = v.get("inherit")
        if inh:
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
    if resolved_vtype:
        standard = resolved_vtype in ("form", "list", "tree", "search", "graph",
                                       "pivot", "calendar", "activity", "dashboard")
        out += check_element_scope(resolved_vtype, elements, vid)
        out += check_raw_seam(resolved_vtype, elements, vid, standard)
        out += check_extra_keys(resolved_vtype, elements, vid, rng_dir)
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
