"""Odoo 视图 arch → 统一视图 DSL（反向转换 / round-trip 入口）。

把存量 Odoo 视图（ir.ui.view 的 arch XML，或单段 arch 片段）反转为 DSL YAML/JSON，
以便纳入 `designer → dsl → odoo` 工作流（把已有视图迁移进 DSL）。

设计原则（与正向生成器对称）：
- 尽量结构化：标准标签 → 对应 DSL Element
  （field/group/notebook/page/button/separator/label/div/filter/header/footer）。
- header/footer/div/label 保留为一等结构元素（属性逐键保留、children 递归展开）；
  只有 sheet 仍是纯布局容器，穿透展开其子元素。
- 不丢信息：无法干净表达的标签/属性用 `raw` 逃逸舱（必带 reason），
  保证产物通过 schema 校验且可回写为原文。
- 多视图聚合：同一 (model, viewType) 的多个 ir.ui.view 聚成一个 ViewTypeBinding，
  并按「primary 优先 + priority 升序」规范化为层栈（层 0 恒为基础层）。
- 同文件 inherit → DSL 切片（extension + inherit + patches）；跨模块 inherit →
  保留为含 '.' 的字面外部基视图引用，仍是合法切片（不再降级为 raw 整段）。
- `<xpath position="attributes"><attribute .../></xpath>` → `patch.attrs[]`；
  其余 position → `patch.elements[]`，与 schema/$defs/Patch 一一对应。
- 传入 `registries`（原始 spec 或 collect_registry 输出）时：arch 中命中
  `viewElements[].tag` 的标签反转为 `{kind: customElement, ref}`，并把
  `viewTypes[]` / `viewElements[]` 原样写回反向产物，保证 round-trip 不丢注册表。
  未提供时无法从 arch 推断注册项，标签退化为 `raw`（既有行为）。

compositions / actions / menus 来自 Odoo 不同记录
（ir.actions.act_window / ir.ui.menu），本工具不反向生成，仅在输出头部标注「请手工补充」。
自定义视图的 OWL 模板内容在 static/src/xml/*.xml，不在 data XML 的 arch 中，
反向转换只能恢复其类型绑定骨架，模板内容需人工补回（已知限制）。
"""
from __future__ import annotations

import argparse
import ast
import contextvars
import json
import re
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
    "field", "group", "notebook", "page", "button", "header", "footer",
    "div", "separator", "label", "filter",
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


# 纯布局包裹（DSL 无对应概念）→ 穿透：展开其子元素到父级 children。
# 只有 sheet 仍是穿透容器；header/footer/div/label 都已是一等 DSL 元素，
# 必须保留为结构化节点，否则它们的属性与子节点会在反向转换中丢失。
PASSTHROUGH = {"sheet"}

# ── 自定义元素注册表上下文（§2.1）──
# 反向转换的 node_to_element 调用链很长（_collect_children / 各 _build_* 递归），
# 用 contextvars 传只读查表，避免给十余个 builder 逐个加参数；每次 arch_to_spec
# 调用都在 finally 里 reset，不会跨调用/跨线程泄漏。
_CUSTOM_TAG_CTX = contextvars.ContextVar("oview_custom_element_tags", default={})


def _registry_list(registries: Optional[Dict], key: str) -> List[Dict]:
    """兼容两种入参：原始 spec（数组）或 collect_registry 的输出（id→def 字典）。"""
    if not registries:
        return []
    items = registries.get(key) or []
    if isinstance(items, dict):
        return [dict(v) for v in items.values() if isinstance(v, dict)]
    if isinstance(items, list):
        return [dict(x) for x in items if isinstance(x, dict)]
    return []


def _custom_tag_lookup(registries: Optional[Dict]) -> Dict[str, str]:
    """tag → 注册表 id（ref）；tag 缺省时等于 id。"""
    out: Dict[str, str] = {}
    for e in _registry_list(registries, "viewElements"):
        if e.get("id"):
            out[e.get("tag") or e["id"]] = e["id"]
    return out


def _attach_registries(spec: Dict, registries: Optional[Dict]) -> Dict:
    """把注册表原样写回反向产物（调用方显式提供时才能做到，不从 arch 猜测）。"""
    if not registries:
        return spec
    vts = _registry_list(registries, "viewTypes")
    ves = _registry_list(registries, "viewElements")
    if vts:
        spec["viewTypes"] = vts
    if ves:
        spec["viewElements"] = ves
    return spec


def _collect_children(elem: Any, vtype: str, warnings: List[str],
                      skip: Tuple[str, ...] = ()) -> List[Dict[str, Any]]:
    """递归收集子元素为 DSL Element 列表；穿透 sheet 纯布局容器。

    skip 用于 xpath 内已单独解析为 attrs 的 <attribute> 节点，避免其被当作
    DSL 元素降级成 raw（此前会让 attributes 型 patch 的 round-trip 失真）。
    """
    out: List[Dict[str, Any]] = []
    for c in _children(elem):
        if _local(c.tag) in skip:
            continue
        if _local(c.tag) in PASSTHROUGH:
            out.extend(_collect_children(c, vtype, warnings, skip=skip))
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
    # 正向生成器产出的 data XML 带 <?xml ... encoding="utf-8"?> 声明；
    # lxml 不接受含 encoding 声明的 unicode 字符串，统一按 utf-8 bytes 传入。
    return _ET.fromstring(text.encode("utf-8"))


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
        # §2.1：命中 viewElements[] 注册项的 tag → 还原为 customElement + ref
        ref = _CUSTOM_TAG_CTX.get().get(tag)
        if ref:
            d: Dict[str, Any] = {
                "kind": "customElement", "ref": ref, "props": dict(_attrib(elem)),
            }
            kids = _collect_children(elem, vtype, warnings)
            if kids:
                d["children"] = kids
            return d
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
        "label": _build_label, "filter": _build_filter, "div": _build_div,
        "header": _build_structure("header"), "footer": _build_structure("footer"),
    }
    return builders[tag](elem, attrib, vtype, warnings)


def _build_structure(kind: str):
    """<header>/<footer> → {kind, children, ...attrs}。

    属性逐键保留（class/groups/invisible/…），children 恒存在（含空数组），
    以满足 schema 的 required: [children] 并保证再正向生成时结构无损。
    """
    def build(elem, attrib, vtype, warnings):
        d: Dict[str, Any] = {"kind": kind}
        d.update(_normalize_layout_attrib(attrib))
        d["children"] = _collect_children(elem, vtype, warnings)
        return d
    return build


def _normalize_layout_attrib(attrib: Dict[str, str]) -> Dict[str, Any]:
    """arch 属性字符串 → DSL 标量（colspan/col 为 integer，nolabel 为 boolean）。

    schema 的 Element 对这几个键有类型约束；原样保留字符串会让反向产物
    通不过结构契约。生成器再把 bool 写成 "1"/"0"，往返无损。
    """
    out: Dict[str, Any] = {}
    for k, v in attrib.items():
        if k in ("colspan", "col"):
            try:
                out[k] = int(v)
            except (TypeError, ValueError):
                out[k] = v
        elif k == "nolabel":
            out[k] = str(v).strip().lower() in ("1", "true", "yes")
        else:
            out[k] = v
    return out


def _build_div(elem, attrib, vtype, warnings):
    """<div> → {kind: div, children, ...attrs}：布局块的结构与属性都不丢。"""
    d: Dict[str, Any] = {"kind": "div"}
    d.update(_normalize_layout_attrib(attrib))
    d["children"] = _collect_children(elem, vtype, warnings)
    return d


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
    # 逐键铺平（for/string/class/groups/invisible/colspan/nolabel/help…），
    # 不再塞进 extra —— 旧版只留 for/string，其余属性在正→反→正中丢失。
    d.update(_normalize_layout_attrib(attrib))
    kids = _collect_children(elem, vtype, warnings)
    if kids:
        d["children"] = kids
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
                   records_by_id=None, default_vtype: Optional[str] = None
                   ) -> Optional[Tuple[Dict, str, str]]:
    """返回 (view_dict, model, vtype)；无法处理返回 None。

    default_vtype：外部基视图切片的 arch 根是 <data>，无法从内容推断视图类型，
    由 `--view-type`（缺省 form）兜底，避免整条跨模块继承视图被跳过。
    """
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

    if vtype is None and is_ext:
        vtype = default_vtype or "form"
        warnings.append(
            f"视图 {rid} 的 viewType 无法从 arch 推断（inherit_id={inherit_ref} 为外部基视图），"
            f"按 {vtype!r} 处理；如不正确请用 --view-type 指定"
        )

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
            # 跨模块基视图：作为字面外部 inherit 保留，切片语义不丢失（规范 §4.1）。
            # 此前降级为 `mode:extension + elements:[raw]` 会产出「缺 inherit」的非法 DSL。
            view["inherit"] = inherit_ref
            warnings.append(
                f"视图 {rid} 的 inherit_id={inherit_ref} 为跨模块外部基视图，"
                f"已作为字面外部 inherit 保留（其存在性需 Odoo 运行时核验）"
            )

        xpaths = [c for c in _children(arch_root) if _local(c.tag) == "xpath"] \
            if _local(arch_root.tag) in ("data",) else \
            [c for c in _children(arch_root) if _local(c.tag) == "xpath"]
        if xpaths:
            patches = []
            for xp in xpaths:
                position = xp.get("position", "inside")
                attr_nodes = [c for c in _children(xp) if _local(c.tag) == "attribute"]
                attrs = [{"name": a.get("name"), "value": (a.text or "").strip()}
                         for a in attr_nodes if a.get("name")]
                expr = xp.get("expr") or ""
                # 定位铁律：@string/@for 可重复、可翻译。反向转换保留原文（不丢信息），
                # 但必须显式告警，避免把不稳定定位悄悄带进 DSL。
                if re.search(r"@\s*(?:string|for)\b", expr, re.IGNORECASE):
                    warnings.append(
                        f"视图 {rid} 的 xpath expr={expr!r} 使用 @string/@for 定位（可能命中多个节点）；"
                        f"原文已保留，建议改写为基于 @name 的唯一锚点"
                    )
                patch: Dict[str, Any] = {"xpath": expr, "position": position}
                if position == "attributes" or attr_nodes:
                    # attributes 型 patch：只写 attrs，不写 elements（schema/生成器双向约束）
                    patch["position"] = "attributes"
                    if attrs:
                        patch["attrs"] = attrs
                    others = [c for c in _children(xp) if _local(c.tag) != "attribute"]
                    if others:
                        warnings.append(
                            f"视图 {rid} 的 xpath expr={xp.get('expr')!r} 同时含 <attribute> 与 "
                            f"{len(others)} 个其它子节点；attributes 模式不接受 elements，已保留警告"
                        )
                else:
                    patch["elements"] = _collect_children(
                        xp, vtype, warnings, skip=("attribute",))
                patches.append(patch)
            view["patches"] = patches
        else:
            # 无 <xpath> 的 extension 无法表达为切片。降级为承载 raw 的 primary，
            # 保证产物仍是合法 DSL（extension 带 elements 会被契约/生成器拒绝），
            # 同时显式告警要求人工补写 inherit/patches。
            warnings.append(
                f"视图 {rid} 无 <xpath>，无法表达为切片；已降级为承载 raw 的 primary 视图，"
                f"请人工补写 inherit/patches（原 inherit_id={inherit_ref}）"
            )
            view["mode"] = "primary"
            view.pop("inherit", None)
            view["elements"] = [_raw_for(
                arch_root,
                reason=f"extension 视图无 <xpath>，无法结构化（原 inherit_id={inherit_ref}）",
            )]
    else:
        view["elements"] = _collect_children(arch_root, vtype, warnings)

    return view, model or "unknown.model", vtype


def _arch_to_spec_impl(text: str, module: str = "converted",
                       model: Optional[str] = None,
                       view_type: Optional[str] = None) -> Tuple[Dict[str, Any], List[str]]:
    """输入 Odoo 视图 XML 文本 → (DSL spec dict, warnings)（内部实现）。"""
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
        res = record_to_view(r, warnings, id_map, records_by_id,
                             default_vtype=view_type)
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

    bindings = []
    for (m, vt) in order:
        views = groups[(m, vt)]
        # 层栈规范化（§4.1）：primary 基础层恒在层 0，切片按 priority 升序跟随。
        # Odoo data XML 里 extension 记录可能出现在 base 之前，直接按文件顺序输出
        # 会让「层 0 = 基础层」的契约失效。
        views.sort(key=lambda v: (
            0 if v.get("mode", "primary") == "primary" else 1,
            v.get("priority") if isinstance(v.get("priority"), int) else 0,
        ))
        bindings.append({
            "model": m, "viewType": vt,
            "prefix": f"{m.replace('.', '_')}_{vt}",
            "views": views,
        })

    return {"module": module, "bindings": bindings}, warnings


def arch_to_spec(text: str, module: str = "converted",
                 model: Optional[str] = None,
                 view_type: Optional[str] = None,
                 registries: Optional[Dict] = None) -> Tuple[Dict[str, Any], List[str]]:
    """Odoo 视图 XML → (DSL spec, warnings)。

    registries: 原始 spec 字典或 `collect_registry(spec)` 输出。提供时命中
    `viewElements[].tag` 的 arch 标签会还原为 `customElement`，并把两类注册表
    写回产物；不提供则维持既有行为（未知标签 → raw）。
    """
    token = _CUSTOM_TAG_CTX.set(_custom_tag_lookup(registries))
    try:
        spec, warnings = _arch_to_spec_impl(
            text, module=module, model=model, view_type=view_type)
    finally:
        _CUSTOM_TAG_CTX.reset(token)
    return _attach_registries(spec, registries), warnings


def dump_yaml(spec: Dict[str, Any]) -> str:
    if yaml is None:
        raise RuntimeError("需要 PyYAML 输出 YAML；请 pip install pyyaml 或加 --json")
    header = (
        "# 由 oview.to_dsl 反向转换生成（Odoo 视图 arch → DSL）\n"
        "# 说明：compositions / actions / menus 来自 Odoo 其它记录\n"
        "#       （ir.actions.act_window / ir.ui.menu），本工具未反向生成，请手工补充。\n"
        "#       自定义视图的 OWL 模板内容在 static/src/xml/*.xml，不在 data XML 的\n"
        "#       arch 中；反向只能恢复类型绑定骨架，模板内容请手工补回。\n"
        "#       传入 --registries 时会写回 viewTypes[] / viewElements[] 注册表。\n"
    )
    return header + yaml.safe_dump(
        spec, sort_keys=False, allow_unicode=True, default_flow_style=False
    )


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Odoo 视图 arch → DSL 反向转换")
    ap.add_argument("input", help="Odoo 视图 XML（含 ir.ui.view record，或单段 arch 片段）")
    ap.add_argument("--module", default=None, help="生成模块名（缺省取文件名 / converted）")
    ap.add_argument("--model", default=None, help="纯 arch 输入时的 model")
    ap.add_argument("--view-type", default=None,
                    help="外部基视图切片（arch 根为 <data>）无法推断视图类型时指定，缺省 form")
    ap.add_argument("--registries", default=None,
                    help="自定义注册表来源（DSL spec 的 .yaml/.json）：还原 customElement 并写回 viewTypes[]/viewElements[]")
    ap.add_argument("--out", default=None, help="输出文件（缺省 stdout）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而非 YAML")
    args = ap.parse_args(argv)

    text = Path(args.input).read_text(encoding="utf-8")
    module = args.module or Path(args.input).stem
    registries = None
    if args.registries:
        rp = Path(args.registries)
        rtext = rp.read_text(encoding="utf-8")
        if rp.suffix.lower() == ".json":
            registries = json.loads(rtext)
        else:
            if yaml is None:
                raise RuntimeError("需要 PyYAML 才能读取 --registries 的 YAML 文件")
            registries = yaml.safe_load(rtext)
    spec, warnings = arch_to_spec(text, module=module, model=args.model,
                                  view_type=args.view_type, registries=registries)

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
