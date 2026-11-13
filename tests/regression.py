#!/usr/bin/env python3
"""View DSL 生成器回归测试：覆盖评审发现的 B1 / B2 / G3。

运行（项目根目录下）：
    python3 tests/regression.py

不依赖 Odoo 运行时，也不依赖 RNG 目录；纯 IR 层 / 生成器层断言。
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)                      # 导入 oview
sys.path.insert(0, os.path.join(ROOT, "validator"))  # 导入 dsl_validate / rng_validate

from oview.qweb_ir import element_to_node  # noqa: E402
import dsl_validate  # noqa: E402


def _ok(name: str) -> None:
    print(f"  [PASS] {name}")


def _fail(name: str, detail: str) -> None:
    print(f"  [FAIL] {name}: {detail}")
    raise SystemExit(1)


# ── B1：dynamicAttr 的 map 模式应生成 t-att（多属性），而非 t-att-{attr} ──
def test_b1_dynamic_attr_modes():
    # map 模式：整个 dict 设置多个属性
    n = element_to_node({"kind": "dynamicAttr", "mode": "map", "value": "{a:1, b:2}"}, vtype="form")
    assert n.get("t-att") == "{a:1, b:2}", f"map 模式未生成 t-att: {n.attrib}"
    assert not any(k.startswith("t-att-") for k in n.attrib), f"map 模式误生成 t-att-*: {n.attrib}"
    # attr 模式（默认）：单属性
    n2 = element_to_node({"kind": "dynamicAttr", "mode": "attr", "attr": "class", "value": "x"}, vtype="form")
    assert n2.get("t-att-class") == "x", f"attr 模式未生成 t-att-class: {n2.attrib}"
    # f 模式：格式化字符串属性
    n3 = element_to_node({"kind": "dynamicAttr", "mode": "f", "attr": "class", "value": "x {y}"}, vtype="form")
    assert n3.get("t-attf-class") == "x {y}", f"f 模式未生成 t-attf-class: {n3.attrib}"
    _ok("B1 dynamicAttr map/attr/f 三种模式输出正确")


# ── B2：未知元素种类必须被拦截（生成器抛错 + 校验器报 ERROR），不再静默通过 ──
def test_b2_unknown_kind_generator_raises():
    try:
        element_to_node({"kind": "fild", "name": "x"})
    except ValueError:
        pass
    else:
        _fail("B2 生成器", "未知 kind `fild` 未抛错（曾静默生成 <span>）")
    _ok("B2 生成器对未知 kind 抛 ValueError")


def test_b2_unknown_kind_validator_errors():
    binding = {
        "model": "x.model", "viewType": "form",
        "views": [{"id": "base", "mode": "primary",
                   "elements": [{"kind": "fild", "name": "x"}]}],
    }
    issues = dsl_validate.validate_binding(binding)
    errs = [i for i in issues if i.severity == "error" and i.code == "ELEMENT_UNKNOWN_KIND"]
    if not errs:
        _fail("B2 校验器", f"未知 kind 未被拦截，issues={[(i.code, i.message) for i in issues]}")
    _ok("B2 校验器对未知 kind 报 ELEMENT_UNKNOWN_KIND ERROR")


# ── G3：自定义 OWL 模板拒绝服务端视图原语（不依赖「先校验后生成」顺序）──
def test_g3_custom_rejects_server_primitives():
    for k in ("notebook", "page", "separator", "filter", "subview"):
        try:
            element_to_node({"kind": k}, vtype="custom")
        except ValueError:
            pass
        else:
            _fail("G3 自保", f"自定义视图中的服务端原语 <{k}> 未抛错")
    # 标准视图仍允许这些原语
    n = element_to_node({"kind": "notebook", "pages": []}, vtype="form")
    assert n.tag == "notebook", "标准 form 视图应允许 <notebook>"
    _ok("G3 自定义视图拒绝 notebook/page/separator/filter/subview；标准视图仍允许")


# ── 健全性：合法 spec 不应触发未知 kind 误报 ──
def test_sanity_known_kinds_no_false_positive():
    binding = {
        "model": "x.model", "viewType": "form",
        "views": [{"id": "base", "mode": "primary", "elements": [
            {"kind": "group", "children": [
                {"kind": "field", "name": "name"},
                {"kind": "button", "string": "OK", "name": "x", "type": "object"},
            ]},
            {"kind": "if", "cond": "a", "children": [{"kind": "label", "string": "L"}]},
            {"kind": "foreach", "expr": "r", "as": "rec", "children": [
                {"kind": "component", "component": "x", "props": {"p": 1}}]},
            {"kind": "set", "var": "v", "value": "1"},
            {"kind": "slot", "name": "s"},
            {"kind": "dynamicAttr", "mode": "f", "attr": "class", "value": "x"},
            {"kind": "call", "name": "frag"},
        ]}],
    }
    issues = dsl_validate.validate_binding(binding)
    false = [i for i in issues if i.code == "ELEMENT_UNKNOWN_KIND"]
    if false:
        _fail("健全性", f"合法元素被误判为未知: {false}")
    _ok("健全性：全部合法元素种类通过，无 ELEMENT_UNKNOWN_KIND 误报")


def main() -> int:
    print("=== View DSL 回归测试 (B1/B2/G3) ===")
    test_b1_dynamic_attr_modes()
    test_b2_unknown_kind_generator_raises()
    test_b2_unknown_kind_validator_errors()
    test_g3_custom_rejects_server_primitives()
    test_sanity_known_kinds_no_false_positive()
    print("=== 全部通过 ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
