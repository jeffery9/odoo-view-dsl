#!/usr/bin/env python3
"""
Odoo 视图 arch → RELAX NG 校验包装器
====================================

把 Odoo 原生的 ``odoo/addons/base/rng/*.rng`` 直接包装为可编程校验器，
对**视图 arch 片段**（而非 ``import_xml.rng`` 的 ``<record>`` 数据文件）做权威结构校验。

与 SKILL.md 现有 `xmllint --relaxng import_xml.rng` 的区别：
  - ``import_xml.rng`` 校验 ``<odoo><record>...`` 数据文件结构；
  - 本模块校验 ``<form>``/``<tree>``/``<search>`` 等 **arch 内容本身**，粒度更精准，
    正是规范 `docs/dsl_qweb_owl_specification.md` §6.5 定义的「RNG 终审」。

依赖：lxml（Odoo 环境自带）。无需 Odoo 运行时、无需数据库。

用法：
  python3 rng_validate.py --view-type form --arch-file arch.xml
  python3 rng_validate.py --view-type list --arch-string '<tree><field name="x"/></tree>'
  python3 rng_validate.py --arch-file arch.xml --json
  ODOO_RNG_DIR=/path/to/base/rng python3 rng_validate.py --view-type form --arch-string ...

退出码：0 = 无 ERROR（含 skip）；1 = 存在 ERROR。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, asdict, field
from typing import Optional

from lxml import etree

# ── 默认 RNG 目录：用户指定的 Odoo 15 checkout；可用环境变量覆盖 ──
DEFAULT_RNG_DIR = os.environ.get(
    "ODOO_RNG_DIR",
    "/Users/jeffery/_project/topdon/USA/odoo-15.0.post20250115/odoo/addons/base/rng",
)

# 视图类型 → RNG 文件名（与 Odoo 15 base/rng 对齐）
VIEW_TYPE_TO_RNG = {
    "form": "form_view.rng",
    "list": "tree_view.rng",
    "tree": "tree_view.rng",
    "search": "search_view.rng",
    "graph": "graph_view.rng",
    "pivot": "pivot_view.rng",
    "calendar": "calendar_view.rng",
    "activity": "activity_view.rng",
    "dashboard": "dashboard_view.rng",
}

# arch 根标签 → 视图类型（用于未显式指定 view-type 时推断）
ROOT_TAG_TO_VIEW_TYPE = {
    "form": "form",
    "tree": "list",
    "search": "search",
    "graph": "graph",
    "pivot": "pivot",
    "calendar": "calendar",
    "activity": "activity",
    "dashboard": "dashboard",
}

# libxml2 RELAX NG 校验错误码（xmlRelaxNGValidityError 枚举的常见值）
# 仅作数字反查后备；主要依据消息关键词规范化（见 _normalize_code）。
RELAXNG_ERR_CODES = {
    1001: "ELEMNAME", 1002: "ELEMNAMEREDEF", 1003: "ELEMNCNAME",
    1006: "EXTRACONTENT", 1007: "MISSING_ATTR", 1008: "INVALID_ATTR",
    1010: "MISSING_ELEM", 1012: "INVALID_CONTENT",
}


def _normalize_code(message: str, type_code: int) -> str:
    """把 libxml2 RNG 校验消息规范为可读错误码，与 SKILL.md 术语对齐。

    优先消息关键词（稳定），数字码仅作后备。
    """
    msg = message.lower()
    if "extra content" in msg or "did not expect element" in msg:
        return "EXTRACONTENT"          # ≡ SKILL.md RELAXNG_ERR_EXTRACONTENT
    if "invalid attribute" in msg or ("not allowed" in msg and "attribute" in msg):
        return "INVALID_ATTR"           # ≡ SKILL.md RELAXNG_ERR_INVALIDATTR
    if "attribute" in msg and ("expect" in msg or "required" in msg or "missing" in msg):
        return "MISSING_ATTR"
    if "element" in msg and ("expect" in msg or "missing" in msg):
        return "MISSING_ELEM"
    if "expect" in msg:
        return "UNEXPECTED_CONTENT"
    return RELAXNG_ERR_CODES.get(int(type_code), f"RNG_TYPE_{type_code}")


@dataclass
class Issue:
    severity: str            # "error" | "warning" | "skip" | "info"
    code: str                # 机器可读码
    message: str
    line: Optional[int] = None
    view_type: Optional[str] = None
    rng_file: Optional[str] = None


@dataclass
class ValidationResult:
    view_type: Optional[str]
    rng_file: Optional[str]
    well_formed: bool = True
    issues: list[Issue] = field(default_factory=list)

    @property
    def has_error(self) -> bool:
        return any(i.severity == "error" for i in self.issues)

    def as_dict(self) -> dict:
        return asdict(self)


_SCHEMA_CACHE: dict[str, "etree.RelaxNG | None"] = {}


def _load_schema(view_type: str, rng_dir: str) -> tuple[Optional["etree.RelaxNG"], Optional[str]]:
    """加载并缓存指定视图类型的 RNG schema。返回 (schema, error_msg)。"""
    cache_key = f"{rng_dir}::{view_type}"
    if cache_key in _SCHEMA_CACHE:
        schema = _SCHEMA_CACHE[cache_key]
        return schema, None

    rng_name = VIEW_TYPE_TO_RNG.get(view_type)
    if rng_name is None:
        _SCHEMA_CACHE[cache_key] = None
        return None, f"未知视图类型: {view_type!r}（合法: {sorted(VIEW_TYPE_TO_RNG)}）"

    rng_path = os.path.join(rng_dir, rng_name)
    if not os.path.isfile(rng_path):
        _SCHEMA_CACHE[cache_key] = None
        return None, f"RNG 文件缺失: {rng_path}（本 checkout 未提供 {rng_name}）"

    try:
        rng_tree = etree.parse(rng_path)  # lxml 自动解析 rng:include href="common.rng"
        schema = etree.RelaxNG(rng_tree)
        _SCHEMA_CACHE[cache_key] = schema
        return schema, None
    except etree.RelaxNGParseError as exc:  # RNG 自身非法（理论上不该发生于 Odoo 官方文件）
        _SCHEMA_CACHE[cache_key] = None
        return None, f"RNG 解析失败 {rng_path}: {exc}"


def validate_arch(
    arch: str | bytes,
    view_type: Optional[str] = None,
    rng_dir: Optional[str] = None,
) -> ValidationResult:
    """对单个视图 arch 做 RNG 校验。arch 为 XML 字符串/字节。

    - 自动推断 view_type（未提供时依据根标签）。
    - RNG 不可用时降级为 skip（不误判），绝不崩溃。
    """
    rng_dir = rng_dir or DEFAULT_RNG_DIR
    result = ValidationResult(view_type=view_type, rng_file=None)

    # 1) XML 良构性（前置快筛）
    try:
        if isinstance(arch, str):
            arch_bytes = arch.encode("utf-8")
        else:
            arch_bytes = arch
        doc = etree.fromstring(arch_bytes)
    except etree.XMLSyntaxError as exc:
        result.well_formed = False
        result.issues.append(Issue(
            severity="error", code="XML_NOT_WELL_FORMED",
            message=f"arch 不是良构 XML: {exc}", view_type=view_type,
        ))
        return result

    root_tag = doc.tag
    if view_type is None:
        view_type = ROOT_TAG_TO_VIEW_TYPE.get(root_tag)
        result.view_type = view_type
    if view_type is None:
        result.issues.append(Issue(
            severity="error", code="UNKNOWN_VIEW_TYPE",
            message=f"无法从根标签 {root_tag!r} 推断视图类型，请显式传入 --view-type",
            view_type=None,
        ))
        return result

    rng_name = VIEW_TYPE_TO_RNG.get(view_type)
    result.rng_file = rng_name

    # 2) 根标签与视图类型一致性提示
    expected_root = {"list": "tree", "tree": "tree"}.get(view_type, view_type)
    if root_tag != expected_root:
        result.issues.append(Issue(
            severity="warning", code="ROOT_TAG_MISMATCH",
            message=f"视图类型 {view_type!r} 期望根标签 <{expected_root}>，实际为 <{root_tag}>",
            view_type=view_type, rng_file=rng_name,
        ))

    # 3) 加载 RNG（含优雅降级）
    schema, err = _load_schema(view_type, rng_dir)
    if schema is None:
        result.issues.append(Issue(
            severity="skip", code="RNG_UNAVAILABLE",
            message=f"RNG 终审跳过：{err}（回退到 IR 级检查）",
            view_type=view_type, rng_file=rng_name,
        ))
        return result

    # 4) 执行 RELAX NG 校验
    try:
        ok = schema.validate(doc)
    except Exception as exc:  # 极端：校验器内部异常，不吞掉，转 error
        result.issues.append(Issue(
            severity="error", code="RNG_VALIDATE_CRASH",
            message=f"RelaxNG 校验异常: {exc}", view_type=view_type, rng_file=rng_name,
        ))
        return result

    if ok:
        result.issues.append(Issue(
            severity="info", code="RNG_PASS",
            message=f"{view_type} arch 通过 {rng_name} 校验",
            view_type=view_type, rng_file=rng_name,
        ))
    else:
        for entry in schema.error_log:
            code_name = _normalize_code(entry.message, entry.type)
            # libxml2 校验错误的 level: 2=ERROR, 3=FATAL；warning=1
            sev = "error" if entry.level >= 2 else "warning"
            result.issues.append(Issue(
                severity=sev,
                code=f"RELAXNG_{code_name}",
                message=entry.message.strip(),
                line=int(entry.line) if entry.line else None,
                view_type=view_type, rng_file=rng_name,
            ))
    return result


def allowed_field_attributes(rng_dir: Optional[str] = None) -> set[str]:
    """从 common.rng 的 ``define[@name='field']`` 抽取合法属性名集合。

    用于 DSL IR 校验中 ``field.extra`` 键的「属不属于 Odoo」判定（规范 §3.2/§6.5）。
    """
    rng_dir = rng_dir or DEFAULT_RNG_DIR
    common_path = os.path.join(rng_dir, "common.rng")
    if not os.path.isfile(common_path):
        return set()
    tree = etree.parse(common_path)
    ns = {"rng": "http://relaxng.org/ns/structure/1.0"}
    field_def = tree.find(".//rng:define[@name='field']", ns)
    if field_def is None:
        return set()
    attrs = set()
    for el in field_def.iter(f"{{{ns['rng']}}}attribute"):
        name = el.get("name")
        if name:
            attrs.add(name)
    # 处理 define 内嵌套 choice/group 中的 attribute
    for el in field_def.iter():
        if el.tag == f"{{{ns['rng']}}}attribute" and el.get("name"):
            attrs.add(el.get("name"))
    return attrs


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Odoo 视图 arch RELAX NG 校验器")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--arch-file", help="arch XML 文件路径")
    src.add_argument("--arch-string", help="arch XML 字符串")
    parser.add_argument("--view-type", help="视图类型: form/list/search/graph/pivot/calendar/activity/dashboard")
    parser.add_argument("--rng-dir", default=None, help=f"RNG 目录（默认 {DEFAULT_RNG_DIR}）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)

    if args.arch_file:
        with open(args.arch_file, "rb") as fh:
            arch = fh.read()
    else:
        arch = args.arch_string.encode("utf-8")

    result = validate_arch(arch, view_type=args.view_type, rng_dir=args.rng_dir)

    if args.json:
        print(json.dumps(result.as_dict(), ensure_ascii=False, indent=2))
    else:
        vt = result.view_type or "?"
        print(f"[view_type={vt}] rng={result.rng_file or '-'} well_formed={result.well_formed}")
        for i in result.issues:
            loc = f":{i.line}" if i.line else ""
            print(f"  - {i.severity.upper()}{loc} [{i.code}] {i.message}")

    return 1 if result.has_error else 0


if __name__ == "__main__":
    sys.exit(main())
