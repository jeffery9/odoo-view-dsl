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
    """ViewTypeBinding.fragments[]：命名可复用片段（t-call 等价物）。"""
    out: Dict[str, List[Dict]] = {}
    for frag in binding.get("fragments", []) or []:
        out[frag["name"]] = frag.get("elements", [])
    return out
