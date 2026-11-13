"""Odoo 视图 arch → 统一视图 DSL（反向转换 / round-trip 入口）。

把存量 Odoo 视图（ir.ui.view 的 arch XML，或单段 arch 片段）反转为 DSL YAML/JSON，
以便纳入 `designer → dsl → odoo` 工作流（把已有视图迁移进 DSL）。

设计原则（与正向生成器对称）：
- 尽量结构化：标准标签 → 对应 DSL Element
  （field/group/notebook/page/button/separator/label/filter）。
- 不丢信息：无法干净表达的标签/属性用 `raw` 逃逸舱（必带 reason），
  保证产物通过 schema 校验且可回写为原文。
- 多视图聚合：同一 (model, viewType) 的多个 ir.ui.view 聚成一个 ViewTypeBinding。
- 同文件 inherit → DSL extension（含 patches）；跨模块 inherit → 整段 raw（标注）。

compositions / actions / menus 来自 Odoo 不同记录
（ir.actions.act_window / ir.ui.menu），本工具不反向生成，仅在输出头部标注「请手工补充」。
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import yaml  # PyYAML（可选；缺失时 --json 仍可用）
except ImportError:  # pragma: no cover
    yaml = None

try:
    from lxml import etree as _ET
    _HAVE_LXML = True
except ImportError:  # pragma: no cover
    import xml.etree.ElementTree as _ET
    _HAVE_LXML = False


# ── 类型映射 ───────────────────────────────────────────────
ROOT_TO_VTYPE = {
    "form": "form", "tree": "list", "list": "list", "search": "search",
    "kanban": "kanban", "graph": "graph", "pivot": "pivot",
    "calendar": "calendar", "activity": "activity", "dashboard": "dashboard",
    "gantt": "gantt", "cohort": "cohort", "map": "map", "qweb": "custom",
}
TYPE_TO_VTYPE = {
    "form": "form", "tree": "list", "search": "search", "kanban": "kanban",
    "graph": "graph", "pivot": "pivot", "calendar": "calendar",
    "activity": "activity", "dashboard": "dashboard", "gantt": "gantt",
    "cohort": "cohort", "map": "map",
}

# 干净映射的 arch 标签（其余 → raw）
KNOWN_TAGS = {
    "field", "group", "notebook", "page", "button",
    "separator", "label", "filter",
}

# field 一等方法属性（直接映射，不进 extra）
_FIELD_PROPS = {
    "name", "string", "widget", "invisible", "readonly", "required",
    "domain", "context", "groups", "colspan", "placeholder", "password",
    "force_save",
}


def _local(tag: Any) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.split("}")[-1]


def _children(elem: Any) -> List[Any]:
    out = []
    for c in elem:
        if not isinstance(getattr(c, "tag", None), str):
            continue
        out.append(c)
    return out


def _attrib(elem: Any) -> Dict[str, str]:
    return {_local(k): v for k, v in (elem.attrib or {}).items()}


# 纯布局包裹（DSL 无对应概念）→ 穿透：展开其子元素到父级 children
PASSTHROUGH = {"header", "sheet", "div"}


def _collect_children(elem: Any, vtype: str, warnings: List[str]) -> List[Dict[str, Any]]:
    """递归收集子元素为 DSL Element 列表；穿透 header/sheet/div 容器。"""
    out: List[Dict[str, Any]] = []
    for c in _children(elem):
        if _local(c.tag) in PASSTHROUGH:
            out.extend(_collect_children(c, vtype, warnings))
        else:
            out.append(node_to_element(c, vtype, warnings))
    return out


def _safe_literal(s: str) -> Any:
    try:
        return ast.literal_eval(s)
    except Exception:
        return s


def _parse_arch(text: str) -> Any:
    text = text.strip()
    if not text:
        return None
    return _ET.fromstring(text)


def _serialize(elem: Any) -> str:
    if _HAVE_LXML:
        return _ET.tostring(elem, encoding="unicode")
    return _ET.tostring(elem, encoding="unicode")


# ── 节点 → DSL Element ─────────────────────────────────────
def _raw_for(elem: Any, reason: str) -> Dict[str, Any]:
    return {"kind": "raw", "qweb": _serialize(elem), "reason": reason}


def node_to_element(elem: Any, vtype: str, warnings: List[str]) -> Dict[str, Any]:
    tag = _local(elem.tag)
    if tag not in KNOWN_TAGS:
        return _raw_for(
            elem, reason=f"arch 标签 <{tag}> 不在 DSL 元素词汇，用 raw 逃逸保留原文"
        )

    attrib = _attrib(elem)

    # attrs：单键 invisible/readonly/required 提取；多键/不可解析 → 整段 raw
    if "attrs" in attrib:
        parsed = _safe_literal(attrib["attrs"])
        if isinstance(parsed, dict) and set(parsed) <= {"invisible", "readonly", "required"}:
            for k, v in parsed.items():
                attrib.setdefault(k, str(v))
        else:
            return _raw_for(
                elem,
                reason=f"attrs 含多键/未知键，DSL 单字段表达会失真: attrs={attrib['attrs']!r}",
            )
        del attrib["attrs"]

    builders = {
        "field": _build_field, "group": _build_group, "notebook": _build_notebook,
        "page": _build_page, "button": _build_button, "separator": _build_separator,
        "label": _build_label, "filter": _build_filter,
    }
    return builders[tag](elem, attrib, vtype, warnings)


def _build_field(elem, attrib, vtype, warnings):
    if "name" not in attrib:
        return _raw_for(elem, reason="<field> 缺少 name 属性，无法表达为 DSL field")
    d: Dict[str, Any] = {"kind": "field", "name": attrib.pop("name")}
    for k in list(attrib):
        if k in _FIELD_PROPS or k == "help":
            v = attrib.pop(k)
            if k in ("domain", "context"):
                v = _safe_literal(v)
            d[k] = v
        elif k == "nolabel":
            d["nolabel"] = (attrib.pop(k) == "1")
        elif k == "options":
            val = attrib.pop(k)
            d["options"] = _safe_literal(val)
    # 残余属性（decoration-* / digits / filename / sum 等）→ extra，保证回写
    if attrib:
        d["extra"] = dict(attrib)
    kids = _collect_children(elem, vtype, warnings)
    if kids:
        d["children"] = kids
    return d


def _build_group(elem, attrib, vtype, warnings):
    d: Dict[str, Any] = {"kind": "group"}
    if "string" in attrib:
        d["string"] = attrib.pop("string")
    if "col" in attrib:
        try:
            d["col"] = int(attrib.pop("col"))
        except ValueError:
            d["col"] = attrib.pop("col")
    if "colspan" in attrib:
        try:
            d["colspan"] = int(attrib.pop("colspan"))
        except ValueError:
            d["colspan"] = attrib.pop("colspan")
    if "groups" in attrib:
        d["groups"] = attrib.pop("groups")
    if attrib:
        d["extra"] = dict(attrib)
    kids = _collect_children(elem, vtype, warnings)
    if kids:
        d["children"] = kids
    return d


def _page_to_dict(elem, vtype, warnings):
    attrib = _attrib(elem)
    pg: Dict[str, Any] = {}
    if "string" in attrib:
        pg["string"] = attrib.pop("string")
    if "groups" in attrib:
        pg["groups"] = attrib.pop("groups")
    if attrib:
        pg["extra"] = dict(attrib)
    kids = [node_to_element(c, vtype, warnings) for c in _children(elem)]
    if kids:
        pg["children"] = kids
    return pg


def _build_notebook(elem, attrib, vtype, warnings):
    d: Dict[str, Any] = {"kind": "notebook"}
    pages = []
    for c in _children(elem):
        if _local(c.tag) == "page":
            pages.append(_page_to_dict(c, vtype, warnings))
        else:
            warnings.append(f"notebook 内出现非 <page> 子元素 <{_local(c.tag)}>，已忽略")
    d["pages"] = pages
    leftover = {k: v for k, v in attrib.items() if k != "string"}
    if "string" in attrib:
        d["string"] = attrib["string"]
    if leftover:
        d["extra"] = leftover
    return d


def _build_page(elem, attrib, vtype, warnings):
    # 独立 page（极少见）→ 返回带 kind:page 的 Element（schema 允许）
    pg = _page_to_dict(elem, vtype, warnings)
    pg["kind"] = "page"
    return pg


def _build_button(elem, attrib, vtype, warnings):
    d: Dict[str, Any] = {"kind": "button"}
    for k in ("string", "type", "name", "icon", "invisible", "groups",
              "confirm", "special", "help"):
        if k in attrib:
            d[k] = attrib.pop(k)
    if attrib:
        d["extra"] = dict(attrib)
    return d


def _build_separator(elem, attrib, vtype, warnings):
    d: Dict[str, Any] = {"kind": "separator"}
    for k in ("string", "colspan", "groups"):
        if k in attrib:
            v = attrib.pop(k)
            if k == "colspan":
                try:
                    v = int(v)
                except ValueError:
                    pass
            d[k] = v
    if attrib:
        d["extra"] = dict(attrib)
    return d


def _build_label(elem, attrib, vtype, warnings):
    d: Dict[str, Any] = {"kind": "label"}
    for k in ("for", "string"):
        if k in attrib:
            d[k] = attrib.pop(k)
    if attrib:
        d["extra"] = dict(attrib)
    return d


def _build_filter(elem, attrib, vtype, warnings):
    if "name" not in attrib:
        return _raw_for(elem, reason="<filter> 缺少 name 属性")
    d: Dict[str, Any] = {"kind": "filter", "name": attrib.pop("name")}
    for k in ("string", "groups"):
        if k in attrib:
            d[k] = attrib.pop(k)
    if "domain" in attrib:
        d["domain"] = _safe_literal(attrib.pop("domain"))
    if "context" in attrib:
        d["context"] = _safe_literal(attrib.pop("context"))
    if attrib:
        d["extra"] = dict(attrib)
    return d


# ── record / 聚合 ──────────────────────────────────────────
def _local_view_id(record_id: str) -> str:
    return record_id.replace(".", "_")


def _extract_arch(record_elem) -> Tuple[Optional[Any], List[str]]:
    warnings: List[str] = []
    for f in record_elem.findall("field"):
        if _local(f.tag) != "field" or f.get("name") != "arch":
            continue
        kids = _children(f)
        if kids:
            return kids[0], warnings
        text = (f.text or "").strip()
        if text:
            try:
                return _parse_arch(text), warnings
            except Exception as ex:
                warnings.append(f"arch 文本解析失败: {ex}")
    return None, warnings


def _model_of(record_elem) -> Optional[str]:
    for f in record_elem.findall("field"):
        if f.get("name") == "model" and f.text:
            return f.text.strip() or None
    return None


def _vtype_of(record_elem, arch_root) -> Optional[str]:
    for f in record_elem.findall("field"):
        if f.get("name") == "type" and f.text:
            return TYPE_TO_VTYPE.get(f.text.strip()) or f.text.strip()
    if arch_root is not None:
        return ROOT_TO_VTYPE.get(_local(arch_root.tag))
    return None


def record_to_view(record_elem, warnings, id_map,
                    records_by_id=None) -> Optional[Tuple[Dict, str, str]]:
    """返回 (view_dict, model, vtype)；无法处理返回 None。"""
    rid = record_elem.get("id")
    if not rid:
        return None
    local_id = _local_view_id(rid)

    model = _model_of(record_elem)
    arch_root, w = _extract_arch(record_elem)
    warnings.extend(w)
    if arch_root is None:
        warnings.append(f"视图 {rid} 无 arch，跳过")
        return None

    vtype = _vtype_of(record_elem, arch_root)
    inherit_ref = None
    for f in record_elem.findall("field"):
        if f.get("name") == "inherit_id":
            inherit_ref = f.get("ref") or (f.get("eval") and f.get("eval").strip("\"'"))
    is_ext = inherit_ref is not None

    # extension 通常无 type、arch 根是 <data> → 回退到继承目标的 viewType
    if vtype is None and is_ext and records_by_id and inherit_ref:
        target_local = _local_view_id(inherit_ref)
        tgt = records_by_id.get(target_local)
        if tgt is not None:
            vtype = _vtype_of(tgt, None)

    if vtype is None:
        warnings.append(
            f"视图 {rid} 无法推断 viewType（root={_local(arch_root.tag)}），跳过"
        )
        return None

    view: Dict[str, Any] = {"id": local_id}
    for f in record_elem.findall("field"):
        if f.get("name") == "name" and f.text:
            view["name"] = f.text.strip()
        elif f.get("name") == "priority" and f.text:
            try:
                view["priority"] = int(f.text.strip())
            except ValueError:
                pass
    view["mode"] = "extension" if is_ext else "primary"

    if is_ext:
        target_local = _local_view_id(inherit_ref) if inherit_ref else None
        if target_local in id_map.values():
            view["inherit"] = target_local
        else:
            warnings.append(
                f"视图 {rid} 的 inherit_id={inherit_ref} 不在本文件，降级为 raw 整段保留"
            )
            view["elements"] = [_raw_for(
                arch_root, reason=f"跨模块继承 {inherit_ref}，DSL 无法干净表达 inherit")]
            return view, model or "unknown.model", vtype

        xpaths = [c for c in _children(arch_root) if _local(c.tag) == "xpath"] \
            if _local(arch_root.tag) in ("data",) else \
            [c for c in _children(arch_root) if _local(c.tag) == "xpath"]
        if xpaths:
            patches = []
            for xp in xpaths:
                patches.append({
                    "xpath": xp.get("expr"),
                    "position": xp.get("position", "inside"),
                    "elements": _collect_children(xp, vtype, warnings),
                })
            view["patches"] = patches
        else:
            view["elements"] = [_raw_for(
                arch_root,
                reason="extension 视图无 <xpath>，DSL 无法结构化（需 xpath/position）",
            )]
    else:
        view["elements"] = _collect_children(arch_root, vtype, warnings)

    return view, model or "unknown.model", vtype


def arch_to_spec(text: str, module: str = "converted",
                 model: Optional[str] = None) -> Tuple[Dict[str, Any], List[str]]:
    """输入 Odoo 视图 XML 文本 → (DSL spec dict, warnings)。"""
    warnings: List[str] = []
    root = _parse_arch(text)
    if root is None:
        return {"module": module, "bindings": []}, warnings

    # 输入形态判定：单段 arch 片段（根即视图类型标签）vs 含 record 的 data XML
    has_record = any(
        isinstance(getattr(c, "tag", None), str) and _local(c.tag) == "record"
        for c in root.iter()
    )
    if _local(root.tag) in ROOT_TO_VTYPE and not has_record:
        vtype = ROOT_TO_VTYPE[_local(root.tag)]
        if not model:
            warnings.append("纯 arch 输入未提供 --model，使用占位 model 'unknown.model'")
            model = "unknown.model"
        view = {
            "id": f"{model.replace('.', '_')}_{vtype}_base",
            "mode": "primary",
            "elements": _collect_children(root, vtype, warnings),
        }
        binding = {
            "model": model, "viewType": vtype,
            "prefix": f"{model.replace('.', '_')}_{vtype}", "views": [view],
        }
        return {"module": module, "bindings": [binding]}, warnings

    # data XML：收集 ir.ui.view records
    records = [
        el for el in root.iter()
        if isinstance(getattr(el, "tag", None), str)
        and _local(el.tag) == "record" and el.get("model") == "ir.ui.view"
    ]
    if not records:
        warnings.append("未找到任何 ir.ui.view record")
        return {"module": module, "bindings": []}, warnings

    id_map: Dict[str, str] = {}
    records_by_id: Dict[str, Any] = {}
    for r in records:
        rid = r.get("id")
        if rid:
            id_map[_local_view_id(rid)] = _local_view_id(rid)
            records_by_id[_local_view_id(rid)] = r

    groups: Dict[Tuple[str, str], List[Dict]] = {}
    order: List[Tuple[str, str]] = []
    for r in records:
        res = record_to_view(r, warnings, id_map, records_by_id)
        if res is None:
            continue
        view, m, vt = res
        m = m or model or "unknown.model"
        vt = vt or "form"
        key = (m, vt)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(view)

    bindings = [{
        "model": m, "viewType": vt,
        "prefix": f"{m.replace('.', '_')}_{vt}",
        "views": groups[(m, vt)],
    } for (m, vt) in order]

    return {"module": module, "bindings": bindings}, warnings


def dump_yaml(spec: Dict[str, Any]) -> str:
    if yaml is None:
        raise RuntimeError("需要 PyYAML 输出 YAML；请 pip install pyyaml 或加 --json")
    header = (
        "# 由 oview.to_dsl 反向转换生成（Odoo 视图 arch → DSL）\n"
        "# 说明：compositions / actions / menus 来自 Odoo 其它记录\n"
        "#       （ir.actions.act_window / ir.ui.menu），本工具未反向生成，请手工补充。\n"
    )
    return header + yaml.safe_dump(
        spec, sort_keys=False, allow_unicode=True, default_flow_style=False
    )


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Odoo 视图 arch → DSL 反向转换")
    ap.add_argument("input", help="Odoo 视图 XML（含 ir.ui.view record，或单段 arch 片段）")
    ap.add_argument("--module", default=None, help="生成模块名（缺省取文件名 / converted）")
    ap.add_argument("--model", default=None, help="纯 arch 输入时的 model")
    ap.add_argument("--out", default=None, help="输出文件（缺省 stdout）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而非 YAML")
    args = ap.parse_args(argv)

    text = Path(args.input).read_text(encoding="utf-8")
    module = args.module or Path(args.input).stem
    spec, warnings = arch_to_spec(text, module=module, model=args.model)

    for w in warnings:
        print(f"# ⚠ {w}", file=sys.stderr)

    if args.json:
        out = json.dumps(spec, ensure_ascii=False, indent=2)
    else:
        out = dump_yaml(spec)

    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(f"已写出 {args.out}", file=sys.stderr)
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
