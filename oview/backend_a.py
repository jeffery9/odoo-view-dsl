"""后端 A：标准 View / ViewTypeBinding / Composition → 服务端（Odoo data XML）。

- View(primary)        → ir.ui.view(model, type, arch)
- View(extension)      → ir.ui.view(inherit_id, mode=extension, arch=<data><xpath/></data>)
- ViewTypeBinding      → 多条 ir.ui.view 记录（base primary + extension(s)），
                         由 Odoo 运行时沿 inherit 链合并为该类型最终结果（规范 §4）
- Composition(act_window) → ir.actions.act_window（view_mode + 可选 view_ids / search_view_id / target）
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple

from lxml import etree

from .model import view_root_tag, normalize_binding, collect_fragments
from .qweb_ir import element_to_node, elements_to_root, node_to_string


def view_xml_id(binding: Dict, view: Dict, module: str) -> str:
    prefix = binding.get("prefix") or f"{binding['model'].replace('.', '_')}_{binding['viewType']}"
    return f"{module}.{prefix}_{view['id']}"


def binding_view_records(binding: Dict, module: str = "dsl_gen") -> List[Dict]:
    """ViewTypeBinding → 多条 ir.ui.view 记录（不预合并，交给 Odoo 运行时）。"""
    binding = normalize_binding(binding)
    bmodel = binding["model"]
    btype = binding["viewType"]
    vtype_root = view_root_tag(btype)
    fragments = collect_fragments(binding)
    id_by_view = {v["id"]: v for v in binding["views"]}
    records: List[Dict] = []

    for v in binding["views"]:
        xid = view_xml_id(binding, v, module)
        fields: Dict[str, Any] = {
            "name": v.get("name", f"{bmodel} ({btype})"),
            "model": bmodel,
            "type": vtype_root,
        }
        if v.get("priority") is not None:
            fields["priority"] = v["priority"]
        groups = v.get("groups") or binding.get("groups")
        if groups:
            fields["_groups"] = groups  # 渲染为 groups_id eval

        mode = v.get("mode", "primary")
        if mode == "primary":
            root = elements_to_root(v.get("elements", []), btype, fragments)
            records.append({
                "xml_id": xid, "model": "ir.ui.view", "fields": fields,
                "arch": node_to_string(root), "inherit": None,
            })
        else:
            inherit_view = id_by_view.get(v["inherit"]) if v.get("inherit") else None
            inherit_xid = view_xml_id(binding, inherit_view, module) if inherit_view else None
            # 扩展 arch：<data> 包裹多个 <xpath>（Odoo ir_ui_view:789 认 data/xpath/position）
            data = etree.Element("data")
            for p in v.get("patches", []):
                xp = etree.SubElement(data, "xpath",
                                      {"expr": p["xpath"], "position": p.get("position", "inside")})
                for el in p.get("elements", []):
                    xp.append(element_to_node(el, btype, fragments))
                for attr in p.get("attrs", []):
                    a = etree.SubElement(xp, "attribute", {"name": attr["name"]})
                    if attr.get("value") is not None:
                        a.text = str(attr["value"])
            fields["mode"] = "extension"
            records.append({
                "xml_id": xid, "model": "ir.ui.view", "fields": fields,
                "arch": node_to_string(data), "inherit": inherit_xid,
            })
    return records


def composition_action_records(
    composition: Dict,
    module: str,
    id_map: Dict[Tuple[int, str], str],
) -> Tuple[List[Dict], List[Dict]]:
    """Composition → ir.actions.act_window(+ ir.actions.act_window.view)。

    返回 (action_records, act_window_view_records)。
    id_map: {(binding_index, view_id): xml_id} 由 pipeline 注入。
    """
    kind = composition.get("kind", "act_window")
    base_id = composition.get("id") or f"action_{composition.get('model','x').replace('.','_')}"
    action_xid = f"{module}.{base_id}"
    act_records: List[Dict] = []
    awv_records: List[Dict] = []

    if kind == "act_window":
        fields: Dict[str, Any] = {
            "name": composition.get("name", "DSL Action"),
            "res_model": composition["model"],
        }
        view_mode = ",".join(vt["viewType"] for vt in composition.get("views", []))
        fields["view_mode"] = view_mode
        if composition.get("target"):
            fields["target"] = composition["target"]
        if composition.get("domain"):
            fields["domain"] = composition["domain"]
        if composition.get("context"):
            fields["context"] = composition["context"]
        if composition.get("limit") is not None:
            fields["limit"] = composition["limit"]
        if composition.get("groups"):
            fields["_groups"] = composition["groups"]

        # search_view_id（G3 补全）
        sv = composition.get("searchViewRef")
        if sv:
            if isinstance(sv, (list, tuple)):
                fields["search_view_id"] = id_map.get(tuple(sv))
            else:
                fields["search_view_id"] = sv

        # view_ids 显式绑定（覆盖 view_mode 顺序/选择，G3 补全）
        view_refs = composition.get("viewRefs")
        if view_refs:
            xml_ids: List[str] = []
            for i, ref in enumerate(view_refs):
                if isinstance(ref, (list, tuple)):
                    xid = id_map.get(tuple(ref))
                else:
                    xid = ref
                if not xid:
                    continue
                xml_ids.append(xid)
                awv_records.append({
                    "xml_id": f"{module}.{base_id}_vw{i}",
                    "model": "ir.actions.act_window.view",
                    "fields": {
                        "act_window_id": f"ref:{action_xid}",
                        "view_id": f"ref:{xid}",
                        "sequence": i,
                    },
                })
            if xml_ids:
                fields["_view_ids"] = xml_ids  # 渲染为 view_ids eval

        act_records.append({"xml_id": action_xid, "model": "ir.actions.act_window", "fields": fields})
    elif kind == "dashboard":
        # 简化：dashboard 以 act_window + view_mode=dashboard 表达（Odoo 原生 dashboard 视图类型）
        fields = {
            "name": composition.get("name", "DSL Dashboard"),
            "res_model": composition.get("model", "board.board"),
            "view_mode": "dashboard",
        }
        act_records.append({"xml_id": action_xid, "model": "ir.actions.act_window", "fields": fields})
    return act_records, awv_records


def render_data_xml(records: List[Dict], root_tag: str = "odoo") -> str:
    """把记录列表渲染为 Odoo data XML（arch 作为内嵌子树，非转义字符串）。"""
    root = etree.Element(root_tag)
    for rec in records:
        r = etree.SubElement(root, "record", {"id": rec["xml_id"], "model": rec["model"]})
        # arch 字段优先（内嵌子树）
        if rec.get("arch") is not None:
            arch_field = etree.SubElement(r, "field", {"name": "arch", "type": "xml"})
            arch_node = etree.fromstring(rec["arch"])
            arch_field.append(arch_node)
        for fname, fval in rec["fields"].items():
            if fname == "_groups":
                gids = [f"ref({g.strip()!r})" for g in str(fval).split(",") if g.strip()]
                etree.SubElement(r, "field", {"name": "groups_id", "eval": f"[(6,0,[{','.join(gids)}])]"})
            elif fname == "_view_ids":
                vids = [f"ref({v!r})" for v in fval]
                etree.SubElement(r, "field", {"name": "view_ids", "eval": f"[(6,0,[{','.join(vids)}])]"})
            elif fname == "search_view_id":
                etree.SubElement(r, "field", {"name": "search_view_id", "ref": str(fval)})
            elif fname == "inherit_id" or (fname == "inherit" ):
                pass  # 由 inherit key 处理
            else:
                if isinstance(fval, (list, dict)):
                    f = etree.SubElement(r, "field", {"name": fname, "eval": repr(fval)})
                else:
                    f = etree.SubElement(r, "field", {"name": fname})
                    f.text = str(fval)
        # inherit 引用（ir.ui.view extension）
        if rec.get("inherit"):
            etree.SubElement(r, "field", {"name": "inherit_id", "ref": rec["inherit"]})
    etree.indent(root, space="    ")
    return etree.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
