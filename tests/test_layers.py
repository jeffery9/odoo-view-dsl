#!/usr/bin/env python3
"""图层 / 切片（Layered inheritance）全链路回归测试（规范 §4.1 / §6.6）。

覆盖：契约反例、IR 校验（含切片内元素）、生成器分派与不静默降级、
反向转换 round-trip、层栈排序、定位键唯一性，以及样例端到端 pipeline。

运行（项目根目录下）：
    python3 tests/test_layers.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "validator"))

import yaml  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402
from lxml import etree  # noqa: E402

import dsl_validate  # noqa: E402
from oview import backend_a, pipeline  # noqa: E402
from oview.to_dsl import arch_to_spec  # noqa: E402


def _ok(name: str) -> None:
    print(f"  [PASS] {name}")


def _fail(name: str, detail: str) -> None:
    print(f"  [FAIL] {name}: {detail}")
    raise SystemExit(1)


def _binding(views, vtype="form", model="sale.order"):
    return {"model": model, "viewType": vtype, "views": views}


def _primary(vid="base", elements=None, **kw):
    d = {"id": vid, "mode": "primary", "elements": elements if elements is not None else []}
    d.update(kw)
    return d


def _slice(vid="s", inherit="base", patches=None, **kw):
    d = {"id": vid, "mode": "extension", "inherit": inherit,
         "patches": patches if patches is not None else []}
    d.update(kw)
    return d


def _patch(xpath="//field[@name='x']", position="after", **kw):
    d = {"xpath": xpath, "position": position}
    d.update(kw)
    return d


def _err_codes(binding):
    return {i.code for i in dsl_validate.validate_binding(binding)
            if i.severity == "error"}


def _all_codes(binding):
    return {i.code for i in dsl_validate.validate_binding(binding)}


# ── 1) 切片内元素不是校验盲区 ──
def test_slice_elements_are_first_class():
    cases = [
        ("未知 kind", [{"kind": "fild", "name": "y"}], "form", "ELEMENT_UNKNOWN_KIND"),
        ("类型作用域", [{"kind": "notebook", "pages": []}], "search", "ELEMENT_SCOPE_VIOLATION"),
        ("raw 缺 reason", [{"kind": "raw", "qweb": "<b/>"}], "form", "RAW_MISSING_REASON"),
    ]
    for name, elements, vtype, expected in cases:
        b = _binding([_primary(), _slice(patches=[_patch(elements=elements)])], vtype=vtype)
        if expected not in _err_codes(b):
            _fail("切片内元素校验", f"{name} 未报 {expected}；实际 {sorted(_err_codes(b))}")
    _ok("切片 patches[].elements 与主视图 elements 同标准校验（未知 kind / 作用域 / raw）")


# ── 2) patch 的 position / 载荷 / 定位键 ──
def test_patch_semantics():
    f = {"kind": "field", "name": "y"}
    cases = [
        ("attributes 缺 attrs", _patch(position="attributes"), "PATCH_ATTRIBUTES_EMPTY"),
        ("attributes 混 elements", _patch(position="attributes",
                                          attrs=[{"name": "invisible", "value": "1"}],
                                          elements=[f]), "PATCH_ELEMENTS_ON_ATTRIBUTES"),
        ("after 带 attrs", _patch(position="after", elements=[f],
                                   attrs=[{"name": "invisible"}]), "PATCH_ATTRS_ON_NON_ATTRIBUTES"),
        ("xpath 为空", _patch(xpath="", elements=[f]), "PATCH_XPATH_EMPTY"),
        ("position 非法", _patch(position="bogus", elements=[f]), "PATCH_POSITION_INVALID"),
        ("@string 定位", _patch(xpath="//group[@string='主要信息']", elements=[f]),
         "PATCH_XPATH_UNSTABLE"),
        ("@for 定位", _patch(xpath="//label[@for='note']", elements=[f]),
         "PATCH_XPATH_UNSTABLE"),
    ]
    for name, patch, expected in cases:
        b = _binding([_primary(), _slice(patches=[patch])])
        if expected not in _err_codes(b):
            _fail("patch 语义", f"{name} 未报 {expected}；实际 {sorted(_err_codes(b))}")
    # 合法的 @name 定位不应误报
    ok_binding = _binding([_primary(), _slice(patches=[
        _patch(elements=[f]),
        _patch(xpath="//field[@name='x']", position="attributes",
                attrs=[{"name": "invisible", "value": "1"}]),
    ])])
    if "PATCH_XPATH_UNSTABLE" in _err_codes(ok_binding) or "PATCH_POSITION_INVALID" in _err_codes(ok_binding):
        _fail("patch 语义", "合法 @name 定位被误报")
    _ok("patch position/载荷互斥 + @name 唯一定位键（禁 @string/@for）")


# ── 3) mode 互斥与 inherit 链 ──
def test_mode_and_inherit_chain():
    f = {"kind": "field", "name": "y"}
    cases = [
        ("primary 带 patches", _binding([_primary(patches=[_patch()])]), "PATCH_ON_PRIMARY"),
        ("primary 带 inherit", _binding([_primary(inherit="base")]), "PRIMARY_HAS_INHERIT"),
        ("extension 带 elements", _binding([_primary(), _slice(elements=[f])]),
         "EXTENSION_HAS_ELEMENTS"),
        ("inherit 目标不存在", _binding([_primary(), _slice(inherit="nope")]),
         "INHERIT_TARGET_MISSING"),
        ("无 primary", _binding([_slice(inherit="nope")]), "NO_PRIMARY"),
    ]
    for name, b, expected in cases:
        if expected not in _err_codes(b):
            _fail("层栈", f"{name} 未报 {expected}；实际 {sorted(_err_codes(b))}")

    # 成环
    cyc = _binding([_primary(), _slice("a", inherit="b"), _slice("b", inherit="a")])
    if "INHERIT_CYCLE" not in _err_codes(cyc):
        _fail("层栈", "inherit 成环未报 INHERIT_CYCLE")
    # 前向引用（层序不单调）
    fwd = _binding([_primary(), _slice("a", inherit="b"), _slice("b", inherit="a")])
    if "INHERIT_FORWARD_REF" not in _all_codes(fwd):
        _fail("层栈", "inherit 前向引用未报 INHERIT_FORWARD_REF")

    # 外部基视图：无 primary 的纯继承模块合法（info，不是 error）
    ext = _binding([_slice("ext", inherit="sale.view_order_form",
                           patches=[_patch(position="attributes",
                                           attrs=[{"name": "invisible", "value": "1"}])])])
    if "NO_PRIMARY" in _err_codes(ext) or "INHERIT_TARGET_MISSING" in _err_codes(ext):
        _fail("层栈", f"外部基视图切片被误判：{sorted(_err_codes(ext))}")
    if "EXTERNAL_BASE_VIEW" not in _all_codes(ext):
        _fail("层栈", "外部基视图未标注 EXTERNAL_BASE_VIEW")
    _ok("mode 互斥、inherit 收敛/无环/层序、外部基视图纯继承模块")


# ── 4) 生成器：按 position 分派 + 不静默降级 ──
def test_generator_dispatch_and_fail_loud():
    b = _binding([_primary(), _slice(patches=[
        _patch(xpath="//field[@name='x']", position="attributes",
               attrs=[{"name": "invisible", "value": "1"}]),
        _patch(xpath="//field[@name='y']", position="after",
               elements=[{"kind": "field", "name": "z"}]),
    ])], )
    recs = backend_a.binding_view_records(b, module="t")
    root = etree.fromstring(recs[1]["arch"])
    xps = root.findall("xpath")
    if len(xps) != 2:
        _fail("生成器分派", f"期望 2 个 xpath，实际 {len(xps)}")
    if xps[0].find("attribute") is None or len(xps[0]) != 1:
        _fail("生成器分派", "position=attributes 应只输出 <attribute>")
    if xps[1].find("field") is None or xps[1].find("attribute") is not None:
        _fail("生成器分派", "position=after 应只输出注入元素")

    ext = _binding([_slice("ext", inherit="sale.view_order_form",
                           patches=[_patch(position="attributes",
                                           attrs=[{"name": "invisible", "value": "1"}])])])
    recs = backend_a.binding_view_records(ext, module="t")
    if recs[0]["inherit"] != "sale.view_order_form":
        _fail("外部基视图", f"inherit 未保留字面 xml_id: {recs[0]['inherit']}")
    xml = backend_a.render_data_xml(recs)
    if 'name="inherit_id" ref="sale.view_order_form"' not in xml:
        _fail("外部基视图", "data XML 缺少 inherit_id ref")

    bad = [
        ("primary 带 patches", _binding([_primary(patches=[_patch()])])),
        ("extension 带 elements", _binding([_primary(), _slice(elements=[{"kind": "field", "name": "x"}])])),
        ("悬空 inherit", _binding([_primary(), _slice(inherit="nope")])),
        ("缺 inherit", _binding([_primary(), _slice(inherit=None)])),
        ("非法 position", _binding([_primary(), _slice(patches=[_patch(position="bogus")])])),
    ]
    for name, bb in bad:
        try:
            backend_a.binding_view_records(bb, module="t")
        except ValueError:
            pass
        else:
            _fail("生成器不静默降级", f"{name} 未抛 ValueError")
    _ok("生成器按 position 分派、外部 inherit 输出正确、非法层组合直接报错")


# ── 5) 反向转换：attribute / 跨模块继承 / 层栈排序 / 定位告警 ──
def test_to_dsl_round_trip():
    xml = """<odoo>
  <record id="my.view_ext" model="ir.ui.view">
    <field name="model">sale.order</field>
    <field name="priority">20</field>
    <field name="inherit_id" ref="sale.view_order_form"/>
    <field name="arch" type="xml"><data>
      <xpath expr="//field[@name='amount_total']" position="attributes">
        <attribute name="invisible">1</attribute>
      </xpath>
      <xpath expr="//field[@name='note']" position="after">
        <field name="client_order_ref"/>
      </xpath>
    </data></field>
  </record>
</odoo>"""
    spec, warns = arch_to_spec(xml, module="t", model="sale.order", view_type="form")
    v = spec["bindings"][0]["views"][0]
    if v["inherit"] != "sale.view_order_form" or v["mode"] != "extension":
        _fail("反向转换", f"跨模块继承未保留为外部基视图切片: {v}")
    if "elements" in v:
        _fail("反向转换", "跨模块继承不应降级为 extension.elements")
    p0, p1 = v["patches"]
    if p0["position"] != "attributes" or p0["attrs"] != [{"name": "invisible", "value": "1"}]:
        _fail("反向转换", f"<attribute> 未反转为 attrs: {p0}")
    if p1.get("elements") != [{"kind": "field", "name": "client_order_ref"}]:
        _fail("反向转换", f"after patch 元素反转错误: {p1}")

    ordered = """<odoo>
  <record id="ext" model="ir.ui.view">
    <field name="model">sale.order</field>
    <field name="inherit_id" ref="base"/>
    <field name="arch" type="xml"><data>
      <xpath expr="//field[@name='x']" position="after"><field name="y"/></xpath>
    </data></field>
  </record>
  <record id="base" model="ir.ui.view">
    <field name="model">sale.order</field>
    <field name="type">form</field>
    <field name="arch" type="xml"><form><field name="x"/></form></field>
  </record>
</odoo>"""
    spec2, _ = arch_to_spec(ordered, module="t")
    views = spec2["bindings"][0]["views"]
    if views[0]["mode"] != "primary" or views[1]["mode"] != "extension":
        _fail("反向转换", f"层 0 未规范化为 primary: {[x['mode'] for x in views]}")

    unstable = """<odoo>
  <record id="ext" model="ir.ui.view">
    <field name="model">sale.order</field>
    <field name="inherit_id" ref="sale.view_order_form"/>
    <field name="arch" type="xml"><data>
      <xpath expr="//page[@string='Notes']" position="inside"><field name="note"/></xpath>
    </data></field>
  </record>
</odoo>"""
    spec3, w3 = arch_to_spec(unstable, module="t", view_type="form")
    if not any("@string" in w for w in w3):
        _fail("反向转换", "存量 @string xpath 未告警")
    if spec3["bindings"][0]["views"][0]["patches"][0]["xpath"] != "//page[@string='Notes']":
        _fail("反向转换", "告警不应篡改原始 xpath（不丢信息）")
    _ok("反向转换：<attribute>→attrs、跨模块 inherit 保留、层栈排序、不稳定定位告警")


# ── 5b) header/footer 结构条：契约、IR 校验、正向生成、反向往返 ──
def test_header_footer_structures():
    schema = yaml.safe_load((ROOT / "schema" / "dsl_schema.yaml").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    header = {"kind": "header", "class": "o_statusbar_buttons", "children": [
        {"kind": "button", "name": "action_confirm", "string": "确认", "type": "object"},
        {"kind": "field", "name": "state", "widget": "statusbar"},
    ]}
    group = {"kind": "group", "children": [{"kind": "field", "name": "partner_id"}]}
    footer = {"kind": "footer", "children": [
        {"kind": "button", "name": "action_cancel", "string": "取消", "type": "object"},
    ]}

    good = {"module": "hf", "bindings": [_binding([_primary(elements=[header, group, footer])])]}
    schema_errs = [e.message for e in validator.iter_errors(good)]
    if schema_errs:
        _fail("结构条契约", f"合法 DSL 未通过 schema: {schema_errs[:2]}")
    b = good["bindings"][0]
    if _err_codes(b):
        _fail("结构条契约", f"合法 DSL 被 IR 校验器拒绝: {sorted(_err_codes(b))}")

    arch = backend_a.binding_view_records(b, module="hf")[0]["arch"]
    root = etree.fromstring(arch)
    if [c.tag for c in root] != ["header", "group", "footer"]:
        _fail("结构条生成", f"arch 子节点顺序错误: {[c.tag for c in root]}")
    if root.find("header").get("class") != "o_statusbar_buttons":
        _fail("结构条生成", "header.class 未透传")
    if root.find("header/button") is None or root.find("footer/button") is None:
        _fail("结构条生成", "header/footer 的子元素未生成")

    # 反向保留结构 → 再正向，arch 逐字一致
    back, _ = arch_to_spec(arch, module="hf", model="sale.order", view_type="form")
    els = back["bindings"][0]["views"][0]["elements"]
    if [e["kind"] for e in els] != ["header", "group", "footer"]:
        _fail("结构条反向", f"header/footer 被穿透或降级: {[e['kind'] for e in els]}")
    if els[0]["class"] != "o_statusbar_buttons" or els[0]["children"][0]["kind"] != "button":
        _fail("结构条反向", "header 属性/子节点丢失")
    if backend_a.binding_view_records(back["bindings"][0], module="hf")[0]["arch"] != arch:
        _fail("结构条往返", "再生成的 arch 与原始 arch 不一致")

    # 结构违规：位置 / 重复 / 嵌套 / 作用域
    bad = [
        ("header 不在首位", [group, header, footer], "form"),
        ("footer 不在末尾", [header, footer, group], "form"),
        ("重复 header", [header, dict(header), group, footer], "form"),
        ("嵌套 footer", [header, {"kind": "group", "children": [footer]}, footer], "form"),
        ("footer 用于 list", [header, group, footer], "list"),
    ]
    for name, elements, vtype in bad:
        codes = _err_codes(_binding([_primary(elements=elements)], vtype=vtype))
        expected = "ELEMENT_SCOPE_VIOLATION" if name.endswith("用于 list") else "ELEMENT_STRUCTURE"
        if expected not in codes:
            _fail("结构条校验", f"{name} 未报 {expected}；实际 {sorted(codes)}")

    # 契约反例：结构条缺 children 必须被 schema 拦截
    no_children = {"module": "hf", "bindings": [_binding([_primary(elements=[{"kind": "header"}])])]}
    if not list(validator.iter_errors(no_children)):
        _fail("结构条契约", "header 缺 children 未被 schema 拦截")
    _ok("header/footer：契约、作用域/位置校验、正向生成、反→正逐字往返")


# ── 5c) div / label：一等元素、属性无损、sheet 仍穿透 ──
def test_div_label_elements():
    schema = yaml.safe_load((ROOT / "schema" / "dsl_schema.yaml").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    label = {"kind": "label", "for": "partner_id", "string": "客户", "class": "o_form_label",
             "colspan": 2, "invisible": "0", "nolabel": False, "extra": {"data-x": "y"}}
    div = {"kind": "div", "class": "oe_title", "groups": "base.group_user",
           "children": [label, {"kind": "field", "name": "partner_id"}]}
    good = {"module": "dl", "bindings": [_binding([_primary(elements=[div])])]}
    if [e.message for e in validator.iter_errors(good)]:
        _fail("div/label 契约", "合法 DSL 未通过 schema")
    if _err_codes(good["bindings"][0]):
        _fail("div/label 契约", f"合法 DSL 被 IR 拒绝: {sorted(_err_codes(good['bindings'][0]))}")

    arch = backend_a.binding_view_records(good["bindings"][0], module="dl")[0]["arch"]
    root = etree.fromstring(arch)
    d = root.find("div")
    if d is None or d.get("class") != "oe_title" or d.get("groups") != "base.group_user":
        _fail("div 生成", "div 结构或属性丢失")
    lab = d.find("label")
    if lab is None or lab.get("for") != "partner_id" or lab.get("colspan") != "2" \
            or lab.get("nolabel") != "0" or lab.get("data-x") != "y":
        _fail("label 生成", f"label 属性未完整透传: {dict(lab.attrib) if lab is not None else None}")
    if d.find("field") is None:
        _fail("div 生成", "div.children 未递归生成")

    # 反向：属性类型回转（colspan→int、nolabel→bool），再正向逐字一致
    back, _ = arch_to_spec(arch, module="dl", model="sale.order", view_type="form")
    els = back["bindings"][0]["views"][0]["elements"]
    if els[0]["kind"] != "div" or els[0]["children"][0]["kind"] != "label":
        _fail("div/label 反向", "div/label 被穿透或降级")
    rev_label = els[0]["children"][0]
    if rev_label["colspan"] != 2 or rev_label["nolabel"] is not False:
        _fail("div/label 反向", "colspan/nolabel 未回转为 integer/boolean")
    if [e.message for e in validator.iter_errors(back)]:
        _fail("div/label 反向", "反向产物未通过 schema（属性类型漂移）")
    if backend_a.binding_view_records(back["bindings"][0], module="dl")[0]["arch"] != arch:
        _fail("div/label 往返", "再生成的 arch 与原始 arch 不一致")

    # sheet 仍是唯一的纯布局穿透容器
    sheet_spec, _ = arch_to_spec(
        "<form><sheet><group><field name='x'/></group></sheet></form>",
        module="dl", model="sale.order", view_type="form")
    if [e["kind"] for e in sheet_spec["bindings"][0]["views"][0]["elements"]] != ["group"]:
        _fail("sheet 穿透", "sheet 不再穿透，或 div 被误当成穿透容器")
    # div.children 递归走元素级校验（不是校验盲区）
    bad = _binding([_primary(elements=[{"kind": "div", "children": [{"kind": "fild"}]}])])
    if "ELEMENT_UNKNOWN_KIND" not in _err_codes(bad):
        _fail("div 校验", "div.children 内的未知 kind 未被拦下")
    _ok("div/label：契约、属性透传+类型回转、正→反→正逐字往返、sheet 仍穿透、children 递归校验")


# ── 6) 契约与样例端到端 ──
def test_schema_and_pipeline():
    sy = yaml.safe_load((ROOT / "schema" / "dsl_schema.yaml").read_text(encoding="utf-8"))
    sj = json.loads((ROOT / "schema" / "dsl_schema.json").read_text(encoding="utf-8"))
    if sy != sj:
        _fail("契约", "YAML / JSON 两份 schema 不等价")
    Draft202012Validator.check_schema(sy)
    validator = Draft202012Validator(sy)
    for f in sorted((ROOT / "examples").glob("*.yaml")):
        doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        errs = [e.message for e in validator.iter_errors(doc)]
        if errs:
            _fail("契约", f"{f.name} 未通过 schema: {errs[:2]}")

    # 样例中所有 patch xpath 只以 @name 定位
    layers = yaml.safe_load((ROOT / "examples" / "sale_order_layers.yaml").read_text(encoding="utf-8"))
    for bnd in layers["bindings"]:
        for v in bnd["views"]:
            for p in v.get("patches", []):
                if re.search(r"@\s*(?:string|for)\b", p["xpath"], re.I):
                    _fail("定位铁律", f"样例含不稳定定位: {p['xpath']}")

    with tempfile.TemporaryDirectory() as tmp:
        with contextlib.redirect_stdout(io.StringIO()):
            errors = pipeline.run(str(ROOT / "examples" / "sale_order_layers.yaml"), tmp)
        if errors:
            _fail("pipeline", f"层栈样例生成返回 {errors} 个 error")
        out = (Path(tmp) / layers["module"] / "views" / "dsl_generated.xml").read_text(encoding="utf-8")
        for needle in ('ref="sale.view_sale_order_search"',
                       '<attribute name="invisible">1</attribute>',
                       'name="client_order_ref"',
                       '<header', '<footer', '<div', 'nolabel="1"'):
            if needle not in out:
                _fail("pipeline", f"产物缺少 {needle}")

        # 正向产物（带 XML 声明）→ 反向转换 → 再正向：闭环不得断裂
        back, _ = arch_to_spec(out, module="rt_demo")
        rev = {b["viewType"]: b for b in back["bindings"]}
        form_views = rev["form"]["views"]
        if [v["mode"] for v in form_views] != ["primary", "extension", "extension"]:
            _fail("round-trip", f"三层链反转异常: {[v['mode'] for v in form_views]}")
        base_els = form_views[0]["elements"]
        if base_els[0]["kind"] != "header" or base_els[-1]["kind"] != "footer":
            _fail("round-trip", "header/footer 结构在正→反过程中丢失或错位")
        if base_els[0]["children"][0]["kind"] != "button":
            _fail("round-trip", "header 子节点丢失")
        if base_els[1]["kind"] != "div" or base_els[1]["children"][0]["kind"] != "label":
            _fail("round-trip", "div/label 结构在正→反过程中丢失")
        if base_els[1]["children"][0].get("colspan") != 2:
            _fail("round-trip", "label.colspan 未回转为 integer")
        if form_views[1]["patches"][0].get("attrs") != [{"name": "invisible", "value": "1"}]:
            _fail("round-trip", "<attribute> 未反转回 attrs")
        if rev["search"]["views"][0]["inherit"] != "sale.view_sale_order_search":
            _fail("round-trip", "外部基视图 inherit 未保留")
        rt_path = Path(tmp) / "roundtrip.yaml"
        rt_path.write_text(yaml.safe_dump(back, sort_keys=False, allow_unicode=True), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            if pipeline.run(str(rt_path), tmp):
                _fail("round-trip", "反向产物再正向生成返回 error")
    _ok("两份 schema 等价、全部样例合法、层栈样例端到端生成 0 error、正→反→正闭环成立")


def main() -> int:
    print("=== 图层 / 切片（Layered inheritance）回归测试 ===")
    test_slice_elements_are_first_class()
    test_patch_semantics()
    test_mode_and_inherit_chain()
    test_generator_dispatch_and_fail_loud()
    test_to_dsl_round_trip()
    test_header_footer_structures()
    test_div_label_elements()
    test_schema_and_pipeline()
    print("=== 全部通过 ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
