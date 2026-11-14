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

from .model import (view_root_tag, normalize_binding, collect_fragments,
                    PATCH_POSITIONS, is_external_inherit)
from .qweb_ir import element_to_node, elements_to_root, node_to_string


def view_xml_id(binding: Dict, view: Dict, module: str) -> str:
    prefix = binding.get("prefix") or f"{binding['model'].replace('.', '_')}_{binding['viewType']}"
    return f"{module}.{prefix}_{view['id']}"


def binding_view_records(binding: Dict, module: str = "dsl_gen",
                          view_elements: Optional[Dict[str, Dict]] = None) -> List[Dict]:
    """ViewTypeBinding → 多条 ir.ui.view 记录（不预合并，交给 Odoo 运行时）。

    层栈语义（规范 §4.1）：层 0 = primary 基础层（全量 elements）；其余 = 切片层
    （extension，inherit 前序层或含 '.' 的外部基视图，内容只来自 patches）。
    **不静默降级**：inherit 无法解析、primary 带 patches、extension 带 elements
    都直接抛 ValueError，避免生成悬空记录或把作者的内容悄悄丢掉。
    """
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
            if v.get("patches"):
                raise ValueError(
                    f"视图 {v['id']!r} 是 primary 基础层却带 patches；"
                    f"patches 只属于 extension 切片（会被生成器忽略）"
                )
            if v.get("inherit"):
                raise ValueError(
                    f"视图 {v['id']!r} 是 primary 基础层却带 inherit；"
                    f"请改为 mode: extension"
                )
            root = elements_to_root(v.get("elements", []), btype, fragments, view_elements)
            records.append({
                "xml_id": xid, "model": "ir.ui.view", "fields": fields,
                "arch": node_to_string(root), "inherit": None,
            })
        else:
            inherit_ref = v.get("inherit")
            if not inherit_ref:
                raise ValueError(
                    f"切片 {v['id']!r} 缺少 inherit（本 binding 层 id 或含 '.' 的外部 xml_id）"
                )
            if is_external_inherit(inherit_ref):
                # 跨模块基视图：字面 xml_id 直接作为 <field ref="..."/>
                inherit_xid = inherit_ref
            else:
                inherit_view = id_by_view.get(inherit_ref)
                if inherit_view is None:
                    raise ValueError(
                        f"切片 {v['id']!r} 的 inherit 目标 {inherit_ref!r} 不存在："
                        f"既非本 binding 内层 id，也非含 '.' 的外部 xml_id；"
                        f"拒绝生成没有 inherit_id 的悬空 extension 记录"
                    )
                inherit_xid = view_xml_id(binding, inherit_view, module)
            if v.get("elements"):
                raise ValueError(
                    f"切片 {v['id']!r} 带 elements：生成器只消费 patches，"
                    f"这些内容会被静默丢弃；请改写为 patches[].elements"
                )

            # 扩展 arch：<data> 包裹多个 <xpath>（Odoo ir_ui_view 认 data/xpath/position）
            # position 决定载荷：attributes 只写 <attribute>，其余只写注入元素（§4.1）。
            data = etree.Element("data")
            for p in v.get("patches", []):
                pos = p.get("position", "inside")
                if pos not in PATCH_POSITIONS:
                    raise ValueError(
                        f"切片 {v['id']!r} 的 patch position={pos!r} 不在 "
                        f"{sorted(PATCH_POSITIONS)} 中"
                    )
                xp = etree.SubElement(data, "xpath", {"expr": p["xpath"], "position": pos})
                if pos == "attributes":
                    for attr in p.get("attrs", []):
                        a = etree.SubElement(xp, "attribute", {"name": attr["name"]})
                        if attr.get("value") is not None:
                            a.text = str(attr["value"])
                else:
                    for el in p.get("elements", []):
                        xp.append(element_to_node(el, btype, fragments, view_elements))
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
    custom_view_xmlid: Optional[Dict[str, str]] = None,
    custom_types: Optional[set] = None,
) -> Tuple[List[Dict], List[Dict]]:
    """Composition → ir.actions.act_window(+ ir.actions.act_window.view)。

    返回 (action_records, act_window_view_records)。
    id_map: {(binding_index, view_id): xml_id} 由 pipeline 注入（含标准与自定义视图）。
    custom_view_xmlid: {vid: xml_id} 自定义视图 ir.ui.view 的 xml_id（供自定义 viewType 引用，G1）。
    custom_types: viewTypes[] 注册的类型键集合；命中时按具名自定义类型进入 view_mode。
    """
    custom_view_xmlid = custom_view_xmlid or {}
    custom_types = custom_types or set()
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
        # view_mode 构建：标准类型直接列名；自定义类型（viewType=custom）经 ir.ui.view(自定义类型) 进入
        view_mode_parts: List[str] = []
        # view_ids 显式绑定（含标准 viewRefs 与自定义视图，统一用 awv 行关联）
        xml_ids: List[str] = []
        for i, vt in enumerate(composition.get("views", [])):
            vtype = vt.get("viewType")
            if vtype == "custom" or vtype in custom_types:
                # 自定义视图进入组合（G1）：关联配套 ir.ui.view(type=自定义键)。
                # 具名自定义类型（viewTypes[] 注册项）用 vtype 作类型键；
                # 兼容字面 custom 仍按 ref 推导类型键（旧样例 partner_card）。
                ref = vt.get("ref")
                if isinstance(ref, str):
                    xid = custom_view_xmlid.get(ref)
                    legacy_key = ref
                elif isinstance(ref, (list, tuple)):
                    xid = id_map.get(tuple(ref)) or custom_view_xmlid.get(ref[1])
                    legacy_key = ref[1] if len(ref) > 1 else ref[0]
                else:
                    xid, legacy_key = None, None
                if not xid:
                    raise ValueError(
                        f"Composition {base_id!r} 的自定义 viewType={vtype!r} "
                        f"缺少可解析的 ref（或 ref 指向不存在的自定义视图），"
                        f"拒绝静默跳过该视图"
                    )
                type_key = legacy_key if vtype == "custom" else vtype
                view_mode_parts.append(type_key)  # 自定义视图类型键（如 partner_board）
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
            else:
                view_mode_parts.append(vtype)
        fields["view_mode"] = ",".join(view_mode_parts)
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
            for i, ref in enumerate(view_refs):
                if isinstance(ref, (list, tuple)):
                    xid = id_map.get(tuple(ref))
                else:
                    xid = ref
                if not xid:
                    continue
                xml_ids.append(xid)
                awv_records.append({
                    "xml_id": f"{module}.{base_id}_vwref{i}",
                    "model": "ir.actions.act_window.view",
                    "fields": {
                        "act_window_id": f"ref:{action_xid}",
                        "view_id": f"ref:{xid}",
                        "sequence": 100 + i,
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


def explicit_action_records(actions: List[Dict], module: str = "dsl_gen") -> List[Dict]:
    """顶层 actions[] → 非视图类 opener（**怎么被打开**）：act_url / act_server / client。

    Composition 已覆盖 act_window（视图类 opener）；这里补足 URL、服务端动作，以及可
    显式声明的自定义客户端动作 `ir.actions.client`（tag 指向 OWL 注册的 action）。
    """
    records: List[Dict] = []
    for a in actions or []:
        aid = a["id"]
        xid = f"{module}.{aid}"
        atype = a.get("type", "url")
        if atype == "url":
            fields = {
                "name": a.get("name", "Open URL"),
                "url": a["url"],
                "target": a.get("target", "new"),
            }
            records.append({"xml_id": xid, "model": "ir.actions.act_url", "fields": fields})
        elif atype == "client":
            # 自定义 action（§2.1）：tag 必须已由 IR 校验器检查过引用完整性
            tag = a.get("tag")
            if not tag:
                raise ValueError(f"action {aid!r} type=client 缺少 tag（不静默降级）")
            fields = {"name": a.get("name", "Client Action"), "tag": tag}
            if a.get("params") is not None:
                fields["params"] = a["params"]
            if a.get("context") is not None:
                fields["context"] = a["context"]
            if a.get("target"):
                fields["target"] = a["target"]
            records.append({"xml_id": xid, "model": "ir.actions.client", "fields": fields})
        elif atype == "server":
            fields = {
                "name": a.get("name", "Server Action"),
                "state": a.get("state", "code"),
            }
            if a.get("model"):
                fields["model_id"] = f"ref:{a['model']}"  # 渲染为 <field name="model_id" ref="..."/>
            if a.get("code"):
                fields["code"] = a["code"]
            records.append({"xml_id": xid, "model": "ir.actions.server", "fields": fields})
    return records


def menu_records(menus: List[Dict], module: str,
                 resolver) -> List[Dict]:
    """顶层 menus[] → ir.ui.menu（**挂到哪**）：把 action 挂载到导航树。

    resolver(ref, kind) -> xml_id | None：解析本 DSL 内引用（composition id / explicit
    action id / menu id）为完整 xml_id；含 '.' 的字面引用原样返回；无法解析返回 None。
    """
    records: List[Dict] = []
    for m in menus or []:
        mid = m["id"]
        xid = f"{module}.{mid}"
        fields: Dict[str, Any] = {"name": m["name"]}
        action_xid = resolver(m.get("action"), kind="action") if m.get("action") else None
        if action_xid:
            fields["action"] = f"ref:{action_xid}"
        if m.get("parent"):
            parent_xid = resolver(m["parent"], kind="menu")
            if parent_xid:
                fields["parent_id"] = f"ref:{parent_xid}"
        if m.get("sequence") is not None:
            fields["sequence"] = m["sequence"]
        if m.get("groups"):
            fields["_groups"] = m["groups"]
        if m.get("icon"):
            fields["web_icon"] = m["icon"]
        records.append({"xml_id": xid, "model": "ir.ui.menu", "fields": fields})
    return records


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
            elif isinstance(fval, str) and fval.startswith("ref:"):
                # 任意字段的 ref 引用（menu.action / menu.parent_id / server.model_id 等）
                etree.SubElement(r, "field", {"name": fname, "ref": fval[4:]})
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
