"""后端 B：自定义 View → OWL 组件三件套 (.js/.xml/.scss) + 注册。

自定义视图不是 Odoo 原生认识的视图，必须 OWL 组件开发（规范 §5）。
生成器硬约束：
  - 不产 `get xxx()`（违反 getters 禁令）→ 用 useState + 方法；
  - 不 `patch` 框架；
  - services 必须显式声明（绑定 ComponentContract.services）；
  - a11y A1–A9：模板根注入 role/aria-label，setup 注入 Esc 关闭骨架。
"""
from __future__ import annotations
import re
from typing import Any, Dict, List, Tuple

from lxml import etree

from .model import collect_fragments, normalize_binding
from .qweb_ir import element_to_node


def _pascal(name: str) -> str:
    parts = [p for p in name.replace("-", "_").split("_") if p]
    return "".join(p[:1].upper() + p[1:] for p in parts) or "CustomView"


def _slug(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z_]", "_", s).strip("_") or "custom"


def _template_inner_xml(elements: List[Dict], fragments: Dict) -> str:
    root = etree.Element("t")
    for el in elements:
        root.append(element_to_node(el, "custom", fragments))
    return etree.tostring(root, encoding="unicode")


def generate_custom_view(view: Dict, binding: Dict, module: str = "dsl_gen") -> Dict:
    """单个自定义 View → 文件集合 + action 记录。"""
    binding = normalize_binding(binding)
    model = view.get("model") or binding.get("model")
    vtype = view.get("viewType") or binding.get("viewType") or "custom"
    name = view.get("name") or view.get("id") or "custom"
    vid = view.get("id") or _slug(name)
    tag = f"{module}.{vid}"
    cls = view.get("className") or _pascal(vid)
    tmpl = f"{module}.{vid}"
    services: List[str] = view.get("services", []) or []
    props: List[str] = view.get("props", []) or []
    fragments = collect_fragments(binding)

    # —— JS 组件（禁 getters、禁 patch、显式 services） ——
    svc_lines = "\n".join(f"        this.{s} = useService({s!r});" for s in services)
    prop_lines = "\n".join(f"        // prop: {p}" for p in props)
    js = f'''/** @odoo-module alias={tag} */
import {{ Component }} from "@odoo/owl";
import {{ useState }} from "@odoo/owl";
import {{ useService }} from "@web/core/utils/hooks";
import {{ registry }} from "@web/core/registry";

// 自定义视图组件：props 来自 action context / env services（非 recordset 绑定）
export class {cls} extends Component {{
    setup() {{
        this.state = useState({{}});
{svc_lines}
{prop_lines}
        // A1–A9 无障碍：Esc 关闭骨架
        this.env.bus.on("keydown", this, (ev) => {{
            if (ev.key === "Escape") this._onClose();
        }});
    }}
    _onClose() {{
        // 由具体业务决定是否关闭；此处保留挂钩
    }}
}}
{cls}.template = {tmpl!r};
// 注册为客户端 action（替代手写 view_registry 字符串游离）
registry.category("actions").add({tag!r}, {cls});
'''
    # —— XML QWeb 模板（t-name 根，复用 QWeb IR） ——
    tname = etree.Element("t", {"t-name": tmpl, "t-att-role": "'region'",
                                "t-att-aria-label": f"{name!r}"})
    for el in view.get("elements", []):
        tname.append(element_to_node(el, "custom", fragments))
    templates = etree.Element("templates")
    templates.append(tname)
    etree.indent(templates, space="    ")
    xml = '<?xml version="1.0" encoding="utf-8"?>\n' + etree.tostring(templates, encoding="unicode")

    # —— SCSS ——
    scss = f""".{name} {{\n    /* DSL 生成的基础样式；自定义样式在此追加 */\n}}\n"""

    files = [
        (f"static/src/js/{vid}.js", js),
        (f"static/src/xml/{vid}.xml", xml),
        (f"static/src/scss/{vid}.scss", scss),
    ]

    # —— 注册记录：ir.actions.client（绑定 res_model + 通过 tag 路由） ——
    action_fields: Dict[str, Any] = {
        "name": view.get("name") or name,
        "tag": tag,
    }
    if model:
        action_fields["res_model"] = model
    if view.get("context"):
        action_fields["context"] = view["context"]
    action_record = {
        "xml_id": f"{module}.action_{vid}",
        "model": "ir.actions.client",
        "fields": action_fields,
    }
    return {"files": files, "action": action_record, "tag": tag, "template": tmpl, "class": cls}


def binding_custom_records(binding: Dict, module: str = "dsl_gen") -> Tuple[List, List]:
    """ViewTypeBinding（custom）→ 所有自定义 View 的文件 + action 记录。"""
    binding = normalize_binding(binding)
    all_files: List[Tuple[str, str]] = []
    action_records: List[Dict] = []
    for v in binding.get("views", []):
        if (v.get("viewType") or binding.get("viewType")) == "custom" or v.get("custom"):
            res = generate_custom_view(v, binding, module)
            all_files.extend(res["files"])
            action_records.append(res["action"])
    return all_files, action_records
