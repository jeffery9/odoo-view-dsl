#!/usr/bin/env python3
"""反向转换工具（Odoo 视图 arch → DSL）集成测试。

覆盖：单段 arch 片段、含 extension(xpath) 的 data XML、search filter、
attrs 单键提取、未知标签 raw 逃逸，以及产物通过 schema/validate.py 门禁。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oview.to_dsl import arch_to_spec  # noqa: E402


FORM_XML = """<form string="Sale Order">
  <header>
    <button name="action_confirm" type="object" string="Confirm" class="btn-primary"/>
  </header>
  <sheet>
    <group string="Partner" col="2">
      <field name="partner_id" widget="many2one" options="{'no_create': True}"/>
      <field name="state" attrs="{'invisible': [('x','=','y')]}"/>
    </group>
    <notebook>
      <page string="Notes"><field name="note"/><newline/></page>
    </notebook>
  </sheet>
</form>
"""

RECORDS_XML = """<odoo>
  <record id="sale.view_order_form" model="ir.ui.view">
    <field name="name">Sale Order Form</field>
    <field name="model">sale.order</field>
    <field name="type">form</field>
    <field name="arch" type="xml"><form><group><field name="partner_id"/></group></form></field>
  </record>
  <record id="sale.view_order_form_ext" model="ir.ui.view">
    <field name="name">Ext</field>
    <field name="model">sale.order</field>
    <field name="inherit_id" ref="sale.view_order_form"/>
    <field name="arch" type="xml"><data><xpath expr="//sheet" position="inside">
      <group><button name="action_validate" type="object" string="Validate"/></group>
    </xpath></data></field>
  </record>
  <record id="sale.view_order_search" model="ir.ui.view">
    <field name="name">Search</field>
    <field name="model">sale.order</field>
    <field name="type">search</field>
    <field name="arch" type="xml"><search>
      <field name="partner_id"/>
      <filter name="my_orders" string="My" domain="[['user_id','=','uid']]"/>
    </search></field>
  </record>
</odoo>
"""


def _find_kinds(elements, acc):
    for el in elements or []:
        if not isinstance(el, dict):
            continue
        acc.append(el.get("kind"))
        _find_kinds(el.get("children"), acc)
        _find_kinds(el.get("pages"), acc)
        for pg in el.get("pages") or []:
            _find_kinds(pg.get("children"), acc)


def test_form_fragment():
    spec, warnings = arch_to_spec(FORM_XML, module="t", model="sale.order")
    assert spec["module"] == "t"
    binding = spec["bindings"][0]
    assert binding["model"] == "sale.order"
    assert binding["viewType"] == "form"
    kinds = []
    _find_kinds(binding["views"][0]["elements"], kinds)
    # header 穿透：button 上提到 form 顶层
    assert "button" in kinds
    assert "group" in kinds
    assert "notebook" in kinds
    # 未知标签 newline → raw
    assert "raw" in kinds
    # attrs 单键提取
    state = next(e for e in binding["views"][0]["elements"]
                 if isinstance(e, dict) and e.get("kind") == "group")
    field = next(c for c in state["children"] if c.get("name") == "state")
    assert field["invisible"] == "[('x', '=', 'y')]"


def test_records_with_extension():
    spec, warnings = arch_to_spec(RECORDS_XML, module="t")
    by_vt = {b["viewType"]: b for b in spec["bindings"]}
    # form binding 含 primary + extension
    form = by_vt["form"]
    modes = [v["mode"] for v in form["views"]]
    assert "primary" in modes and "extension" in modes
    ext = next(v for v in form["views"] if v["mode"] == "extension")
    assert ext["inherit"] == "sale_view_order_form"
    assert ext["patches"][0]["xpath"] == "//sheet"
    assert ext["patches"][0]["position"] == "inside"
    # search binding 含 filter
    search = by_vt["search"]
    kinds = []
    _find_kinds(search["views"][0]["elements"], kinds)
    assert "filter" in kinds


def test_schema_gateway():
    """产物必须通过仓库 schema/validate.py 门禁（含反例拦截）。"""
    for xml, model in [(FORM_XML, "sale.order"), (RECORDS_XML, None)]:
        spec, _ = arch_to_spec(xml, module="t", model=model)
        tmp = ROOT / "tests" / "_tmp_to_dsl.yaml"
        tmp.write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True),
                       encoding="utf-8")
        r = subprocess.run(
            [sys.executable, str(ROOT / "schema" / "validate.py"), str(tmp)],
            capture_output=True, text=True,
        )
        assert r.returncode == 0, f"schema 门禁失败:\n{r.stdout}\n{r.stderr}"
        tmp.unlink()


if __name__ == "__main__":
    test_form_fragment()
    test_records_with_extension()
    test_schema_gateway()
    print("=== test_to_dsl 全部通过 ===")
