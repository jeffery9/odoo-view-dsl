"""DSL 源 IR：加载 YAML（主）/ JSON（兼容），规范化 binding 层 model/viewType 继承回退。

**DSL 主语言是 YAML**：作者以 `.yaml` 书写规范，可读性最佳且支持注释/多行。
JSON 仍被加载器接受（兼容历史/程序生成），但示例与文档一律以 YAML 为准。
源 IR 与规范 §2 一致，且为 dict 形态（"kind" 判别字段），便于直接对接
vendored 的 dsl_validate.py / rng_validate.py（两者均按 dict 校验）。
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml  # 可选依赖；缺失时仅支持 JSON 输入
except ImportError:  # pragma: no cover
    yaml = None


# 标准视图类型（Odoo 原生熟知，服务端直接消费）
STANDARD_TYPES = {
    "form", "list", "tree", "search", "graph", "pivot",
    "calendar", "activity", "dashboard", "kanban",
    "gantt", "cohort", "map",
}
# 标准类型在 arch 根标签上的映射（list → tree，Odoo 内部用 tree）
ROOT_TAG = {"list": "tree", "tree": "tree"}

# 切片 patch 的合法 position。与 schema/$defs/Patch 及
# validator/dsl_validate.py 的 PATCH_POSITIONS 保持同步（校验器独立可运行，故各持副本）。
PATCH_POSITIONS = {"inside", "after", "before", "replace", "attributes"}


def is_external_inherit(ref) -> bool:
    """inherit 是否为字面外部 xml_id（跨模块基视图，含 '.'）。

    切片层栈的根既可以是本 binding 的 primary 基础层，也可以是外部模块的
    ir.ui.view；后者直接作为 `<field name="inherit_id" ref="..."/>` 输出。
    """
    return isinstance(ref, str) and "." in ref


def load_spec(path: str | Path) -> Dict[str, Any]:
    """加载 DSL 规格文件（.yaml / .yml 为主；.json 兼容）。

    推荐以 YAML 书写（DSL 主语言）；JSON 仅作兼容/程序生成用途。
    """
    text = Path(path).read_text(encoding="utf-8")
    suffix = str(path).lower()
    if suffix.endswith((".yaml", ".yml")):
        if yaml is None:
            raise RuntimeError("需要 PyYAML 才能解析 .yaml；请 `pip install pyyaml` 或用 .json")
        return yaml.safe_load(text)
    return json.loads(text)


def normalize_binding(binding: Dict[str, Any]) -> Dict[str, Any]:
    """把 binding 层的 model/viewType 继承到每个 View；仅当两层都缺失才报错（由校验器负责）。"""
    bmodel = binding.get("model")
    btype = binding.get("viewType")
    for v in binding.get("views", []):
        if v.get("model") is None:
            v["model"] = bmodel
        if v.get("viewType") is None:
            v["viewType"] = btype
    return binding


def view_root_tag(view_type: str) -> str:
    return ROOT_TAG.get(view_type, view_type)


def is_standard(view_type: str) -> bool:
    return view_type in STANDARD_TYPES


def collect_fragments(binding: Dict[str, Any]) -> Dict[str, List[Dict]]:
    """ViewTypeBinding.fragments[]：命名可复用片段（t-call 等价物）。

    片段体取 `children`（规范 §2 权威命名）或 `elements`（兼容旧写法），
    两者皆可；同时缺失视为空片段（call 展开为空，不静默吞错——片段名缺失由校验器报 ERROR）。
    """
    out: Dict[str, List[Dict]] = {}
    for frag in binding.get("fragments", []) or []:
        out[frag["name"]] = frag.get("children") or frag.get("elements") or []
    return out


def collect_registry(spec: Dict[str, Any]) -> Dict[str, Dict[str, Dict]]:
    """顶层三类自定义注册表（§2.1）→ 按 id 索引。

    `viewTypes[]` / `viewElements[]` 是「先声明后引用」的契约表；索引后供生成器、
    QWeb IR 与反向转换消费。注册表为空时返回空字典，旧写法仍走兼容路径。
    """
    view_types: Dict[str, Dict] = {}
    for t in spec.get("viewTypes", []) or []:
        if isinstance(t, dict) and t.get("id"):
            view_types[t["id"]] = t
    view_elements: Dict[str, Dict] = {}
    for e in spec.get("viewElements", []) or []:
        if isinstance(e, dict) and e.get("id"):
            view_elements[e["id"]] = e
    return {"viewTypes": view_types, "viewElements": view_elements}


def resolve_custom_type(binding: Dict[str, Any], view: Dict[str, Any],
                        registry: Optional[Dict[str, Dict[str, Dict]]] = None
                        ) -> tuple[bool, Optional[Dict]]:
    """判定一条 View 是否走后端 B，并返回其自定义类型契约。

    优先命中 `viewTypes[]` 注册项（注册表为权威）；未注册的旧写法
    （`custom: true` / `viewType: custom`）合成一个隐式注册项，类型键取 view.id，
    保持既有样例逐字兼容。返回 (is_custom, typedef | None)。
    """
    reg = (registry or {}).get("viewTypes", {})
    vtype = view.get("viewType") or binding.get("viewType")
    if vtype in reg:
        typedef = dict(reg[vtype])
        # view 级字段仅补齐注册表未声明的元数据（兼容旧样例的 view 级 className 等）
        for k in ("className", "services", "props", "name", "context"):
            if typedef.get(k) is None and view.get(k) is not None:
                typedef[k] = view[k]
        return True, typedef
    legacy = (binding.get("custom") or view.get("custom")
              or vtype == "custom" or binding.get("viewType") == "custom")
    if legacy:
        vid = view.get("id") or vtype or "custom"
        typedef = {"id": vid}
        for k in ("className", "services", "props", "name", "context"):
            if view.get(k) is not None:
                typedef[k] = view[k]
        return True, typedef
    return False, None
