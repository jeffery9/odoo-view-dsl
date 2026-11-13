"""QWeb IR 与序列化：把 DSL Element 降低为 QWeb IR 节点，再序列化为 arch XML。

两层降低：DSL Element ──→ QWeb IR 节点（含 RawNode 降级）──→ lxml Element。
`raw` 不是绕过管线，而是降低为 QWeb IR 内部节点（必须带 reason），与一等元素
共用同一条序列化 / 继承 / 组合 / 校验路径（对应规范 §3.1）。
"""
from __future__ import annotations
import json
from typing import Any, Dict, List, Optional

from lxml import etree

# 已知字段属性（非 extra），生成时跳过
_FIELD_KNOWN = {
    "kind", "name", "widget", "string", "options", "invisible", "readonly",
    "required", "domain", "context", "groups", "children", "pages", "col",
    "icon", "type", "colspan", "for", "viewRef", "component", "props",
    "cond", "as", "var", "value", "fallback", "attr", "mode", "with",
    "block", "qweb", "reason", "extra",
}

# 生成器支持的全部元素种类（DSL IR 层已知集合）。
# 与 validator/dsl_validate.py 中的 KNOWN_KINDS 保持同步：校验器须独立可运行，
# 不从本模块 import，故两处各持一份副本（变更时需同步）。
KNOWN_KINDS = {
    "field", "group", "notebook", "page", "button", "separator", "label",
    "filter", "subview", "component", "if", "foreach", "set", "slot",
    "dynamicAttr", "call", "raw",
}

# 这些元素是服务端（标准）视图原语，自定义 OWL 模板不应出现（G3 生成器自保）。
# 与标准视图不同：自定义视图是纯 QWeb/HTML 模板，没有 <notebook>/<filter> 等 Odoo 结构。
_SERVER_ONLY_KINDS = {"notebook", "page", "separator", "filter", "subview"}


def _set_if(elem: etree._Element, key: str, val: Any) -> None:
    if val is None:
        return
    elem.set(key, str(val))


def _collect_children(elem: Dict) -> List[Dict]:
    out: List[Dict] = []
    for key in ("children", "pages"):
        sub = elem.get(key)  # pages: list of {string, children}
        if not sub:
            continue
        if key == "children":
            out.extend(sub)
        else:  # pages → 已是 page 节点
            for p in sub:
                pg = {"kind": "page", "string": p.get("string"), "groups": p.get("groups"),
                      "children": p.get("children", [])}
                out.append(pg)
    return out


def element_to_node(
    elem: Dict,
    vtype: Optional[str] = None,
    fragments: Optional[Dict[str, List[Dict]]] = None,
) -> etree._Element:
    """把单个 DSL Element 降低为 lxml 节点。"""
    kind = elem.get("kind")
    fragments = fragments or {}

    # 不静默降级铁律（规范 §6.4）：未知/缺失 kind 直接抛错，绝不产出 <span> 死节点。
    if kind is None:
        raise ValueError(f"Element 缺少 kind 字段: {elem!r}")
    if kind not in KNOWN_KINDS:
        raise ValueError(
            f"未知元素种类 {kind!r}：不在 DSL 元素词汇中，"
            f"不再静默降级为 <span> 死节点（违反规范「不静默降级」原则）"
        )
    # G3 生成器自保：自定义 OWL 模板拒绝服务端视图原语（不依赖「先校验后生成」顺序）。
    if vtype == "custom" and kind in _SERVER_ONLY_KINDS:
        raise ValueError(
            f"元素 <{kind}> 是服务端（标准）视图原语，不能出现在自定义 OWL 模板中 "
            f"(vtype=custom)：自定义视图是纯 QWeb/HTML，应使用 if/foreach/component 等表达"
        )

    if kind == "field":
        # 自定义视图（OWL 模板）无 <field> 标签：映射为 t-esc 显示 props 字段
        if vtype == "custom":
            e = etree.Element("t")
            e.set("t-esc", f"props.{elem['name']}")
            return e
        e = etree.Element("field")
        e.set("name", elem["name"])
        for k in ("widget", "string", "invisible", "readonly", "required",
                  "domain", "context", "groups", "force_save", "placeholder", "password"):
            _set_if(e, k, elem.get(k))
        if elem.get("options") is not None:
            e.set("options", json.dumps(elem["options"], ensure_ascii=False))
        for k, v in (elem.get("extra") or {}).items():
            e.set(k, str(v))
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "group":
        e = etree.Element("group")
        _set_if(e, "string", elem.get("string"))
        _set_if(e, "col", elem.get("col"))
        _set_if(e, "groups", elem.get("groups"))
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "notebook":
        e = etree.Element("notebook")
        for p in elem.get("pages", []):
            pg = etree.SubElement(e, "page")
            _set_if(pg, "string", p.get("string"))
            _set_if(pg, "groups", p.get("groups"))
            for c in p.get("children", []):
                pg.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "page":
        e = etree.Element("page")
        _set_if(e, "string", elem.get("string"))
        _set_if(e, "groups", elem.get("groups"))
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "button":
        e = etree.Element("button")
        _set_if(e, "string", elem.get("string"))
        _set_if(e, "type", elem.get("type", "object"))
        _set_if(e, "name", elem.get("name"))
        _set_if(e, "icon", elem.get("icon"))
        _set_if(e, "invisible", elem.get("invisible"))
        _set_if(e, "groups", elem.get("groups"))
        _set_if(e, "confirm", elem.get("confirm"))
        _set_if(e, "special", elem.get("special"))
        _set_if(e, "help", elem.get("help"))
        for k, v in (elem.get("extra") or {}).items():
            e.set(k, str(v))
        return e

    if kind == "separator":
        e = etree.Element("separator")
        _set_if(e, "string", elem.get("string"))
        _set_if(e, "colspan", elem.get("colspan"))
        _set_if(e, "groups", elem.get("groups"))
        return e

    if kind == "label":
        e = etree.Element("label")
        _set_if(e, "for", elem.get("for"))
        _set_if(e, "string", elem.get("string"))
        return e

    if kind == "filter":
        # search 视图专属：<filter name string domain context groups/>
        e = etree.Element("filter")
        _set_if(e, "name", elem.get("name"))
        _set_if(e, "string", elem.get("string"))
        if elem.get("domain") is not None:
            e.set("domain", str(elem["domain"]))
        if elem.get("context") is not None:
            e.set("context", str(elem["context"]))
        _set_if(e, "groups", elem.get("groups"))
        return e

    if kind == "subview":
        # 嵌入另一 View：以 field 指向 o2m/m2m 字段（Odoo 标准子视图机制）
        e = etree.Element("field")
        e.set("name", elem["viewRef"])
        _set_if(e, "context", elem.get("context"))
        return e

    if kind == "component":
        # 自定义：OWL 组件嵌入（QWeb 模板中的 t-component）
        e = etree.Element("div")
        e.set("t-component", elem["component"])
        for k, v in (elem.get("props") or {}).items():
            e.set(f"t-props-{k}", str(v))
        return e

    if kind == "if":
        e = etree.Element("t")
        e.set("t-if", elem["cond"])
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        for el in (elem.get("else") or []):
            en = etree.SubElement(e, "t")
            en.set("t-else", "")
            en.append(element_to_node(el, vtype, fragments))
        return e

    if kind == "foreach":
        e = etree.Element("t")
        e.set("t-foreach", elem["expr"])
        e.set("t-as", elem["as"])
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "set":
        e = etree.Element("t")
        e.set("t-set", elem["var"])
        if elem.get("value") is not None:
            e.set("t-value", str(elem["value"]))
        for c in elem.get("children", []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "slot":
        e = etree.Element("t")
        e.set("t-slot", elem["name"])
        for c in (elem.get("fallback") or []):
            e.append(element_to_node(c, vtype, fragments))
        return e

    if kind == "dynamicAttr":
        e = etree.Element("t")
        mode = elem.get("mode", "attr")
        if mode == "f":
            # 格式化字符串属性：t-attf-{name} = "format {expr}"
            e.set(f"t-attf-{elem['attr']}", elem["value"])
        elif mode == "map":
            # 多属性映射：t-att = {a:1, b:2} —— 按 dict 同时设置多个属性。
            # 注意：不是 t-att-{attr}（那是「单属性模式」，attr 变成属性名后缀）。
            e.set("t-att", elem["value"])
        else:
            # 单属性模式（默认 attr）：t-att-{name} = expr
            e.set(f"t-att-{elem['attr']}", elem["value"])
        return e

    if kind == "call":
        # t-call 命名片段：展开为片段节点（替代手写 t-call 字符串游离）
        e = etree.Element("t")
        e.set("t-call", elem["name"])
        for k, v in (elem.get("with") or {}).items():
            e.set(f"t-call-{k}", str(v))
        for sub in fragments.get(elem["name"], []):
            e.append(element_to_node(sub, vtype, fragments))
        return e

    if kind == "raw":
        # 降级进 QWeb IR：解析 qweb 字符串为节点（必带 reason，校验器已在 IR 层卡控）
        try:
            return etree.fromstring(elem["qweb"])
        except Exception as ex:  # 解析失败 → 标记节点，不静默丢失
            e = etree.Element("span")
            e.set("data-raw-error", str(ex))
            return e

    # 兜底：理论上不会到达（顶部已对未知 kind 抛错）；保留为防御性失败，绝不静默生成死节点。
    raise ValueError(f"未处理的元素种类 {kind!r}（element_to_node 遗漏分支，请上报）")


def elements_to_root(elements: List[Dict], vtype: str,
                     fragments: Optional[Dict[str, List[Dict]]] = None) -> etree._Element:
    """多个顶层元素包进视图根标签。"""
    from .model import view_root_tag
    root = etree.Element(view_root_tag(vtype))
    for el in elements:
        root.append(element_to_node(el, vtype, fragments))
    return root


def node_to_string(node: etree._Element) -> str:
    return etree.tostring(node, encoding="unicode")
