#!/usr/bin/env python3
"""三类自定义注册表全链路回归测试（规范 §2.1 / §6.7）。

覆盖：viewTypes[]（自定义 view type）/ viewElements[]（自定义 view element）/
actions[].type=client（自定义 action）的契约、IR 引用完整性、生成器、
反向转换、旧写法兼容，以及样例端到端 pipeline。

运行（项目根目录下）：
    python3 tests/test_custom_registry.py
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "validator"))

import yaml  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

import dsl_validate  # noqa: E402
from oview import backend_a, backend_b, pipeline, qweb_ir  # noqa: E402
from oview.model import collect_registry, resolve_custom_type  # noqa: E402
from oview.to_dsl import arch_to_spec  # noqa: E402


def _ok(name: str) -> None:
    print(f"  [PASS] {name}")


def _fail(name: str, detail: str) -> None:
    print(f"  [FAIL] {name}: {detail}")
    raise SystemExit(1)


def _schema() -> dict:
    return yaml.safe_load((ROOT / "schema/dsl_schema.yaml").read_text(encoding="utf-8"))


def _example() -> dict:
    return yaml.safe_load((ROOT / "examples/custom_registry.yaml").read_text(encoding="utf-8"))


def _errors(doc: dict, schema: dict) -> list[str]:
    return [e.message for e in Draft202012Validator(schema).iter_errors(doc)]


# ── 1) 结构契约 ──
def test_contract() -> None:
    j = json.loads((ROOT / "schema/dsl_schema.json").read_text(encoding="utf-8"))
    y = _schema()
    if j != y:
        _fail("契约", "dsl_schema.yaml 与 .json 不等价")
    Draft202012Validator.check_schema(j)
    if _errors(_example(), y):
        _fail("契约", f"custom_registry.yaml 未通过 schema: {_errors(_example(), y)[:2]}")

    base = {"module": "x", "bindings": [
        {"model": "sale.order", "viewType": "form", "views": [{"id": "v", "elements": []}]}]}
    counters = {
        "customElement 缺 ref": {"elements": [{"kind": "customElement"}]},
        "viewType 注册项缺 id": {"viewTypes": [{"name": "看板"}]},
        "viewElement 注册项 id 非法": {"viewElements": [{"id": "1-bad"}]},
        "props 契约项缺 name": {"viewElements": [{"id": "badge", "props": [{"required": True}]}]},
        "client action 缺 tag": {"actions": [{"id": "a", "type": "client"}]},
        "url action 缺 url": {"actions": [{"id": "a", "type": "url"}]},
    }
    for label, extra in counters.items():
        doc = json.loads(json.dumps(base))
        doc.update(extra)
        if "elements" in extra:
            doc["bindings"][0]["views"][0]["elements"] = extra["elements"]
        if not _errors(doc, y):
            _fail("契约反例", f"「{label}」未被 schema 拦截")
    _ok("两份 schema 等价、样例合法、6 个注册表反例均被拦截")


# ── 2) IR 引用完整性 ──
def test_registry_validation() -> None:
    spec = _example()
    issues = dsl_validate.check_registry_refs(spec)
    if [i for i in issues if i.severity == "error"]:
        _fail("IR 正例", f"合法样例被误报: {[(i.code, i.message) for i in issues]}")

    def codes(doc: dict) -> set[str]:
        return {i.code for i in dsl_validate.check_registry_refs(doc) if i.severity == "error"}

    bad_type = json.loads(json.dumps(spec))
    bad_type["bindings"][1]["viewType"] = "partener_board"
    if "CUSTOM_TYPE_UNREGISTERED" not in codes(bad_type):
        _fail("IR", "未注册的自定义 viewType 未被拦截")

    bad_ref = json.loads(json.dumps(spec))
    bad_ref["bindings"][1]["views"][0]["elements"][0]["ref"] = "no_such_element"
    if "CUSTOM_ELEMENT_UNREGISTERED" not in codes(bad_ref):
        _fail("IR", "悬空 customElement.ref 未被拦截")

    missing_prop = json.loads(json.dumps(spec))
    missing_prop["bindings"][1]["views"][0]["elements"][0]["props"] = {}
    if "CUSTOM_ELEMENT_PROP_MISSING" not in codes(missing_prop):
        _fail("IR", "缺失 required prop 未被拦截")

    unknown_prop = json.loads(json.dumps(spec))
    unknown_prop["bindings"][1]["views"][0]["elements"][0]["props"]["bogus"] = "1"
    if "CUSTOM_ELEMENT_PROP_UNKNOWN" not in codes(unknown_prop):
        _fail("IR", "未声明 prop 未被拦截")

    dup = json.loads(json.dumps(spec))
    dup["viewTypes"].append(dict(dup["viewTypes"][0]))
    if "CUSTOM_TYPE_DUPLICATE" not in codes(dup):
        _fail("IR", "重复类型键未被拦截")

    reserved = json.loads(json.dumps(spec))
    reserved["viewElements"].append({"id": "field", "tag": "F"})
    if "CUSTOM_ELEMENT_RESERVED" not in codes(reserved):
        _fail("IR", "自定义元素 id 侵占内置 kind 未被拦截")

    sliced = json.loads(json.dumps(spec))
    sliced["bindings"][1]["views"].append(
        {"id": "s", "mode": "extension", "inherit": "partner_board_main", "patches": []})
    if "CUSTOM_TYPE_INHERIT_UNSUPPORTED" not in codes(sliced):
        _fail("IR", "自定义类型的 inherit 切片未被拦截")

    no_tag = json.loads(json.dumps(spec))
    no_tag["actions"][0].pop("tag")
    if "CUSTOM_ACTION_TAG_MISSING" not in codes(no_tag):
        _fail("IR", "client action 缺 tag 未被拦截")

    unused = json.loads(json.dumps(spec))
    unused["viewElements"].append({"id": "unused_tile", "tag": "UnusedTile"})
    warns = {i.code for i in dsl_validate.check_registry_refs(unused) if i.severity == "warning"}
    if "CUSTOM_ELEMENT_UNUSED" not in warns:
        _fail("IR", "未使用注册项未给出 WARNING")
    _ok("IR 引用完整性：8 类违规拦截、未使用声明告警，合法样例 0 error")


# ── 3) 生成器 ──
def test_generators() -> None:
    spec = _example()
    reg = collect_registry(spec)
    if set(reg["viewTypes"]) != {"partner_board"} or set(reg["viewElements"]) != {"status_badge", "metric_tile"}:
        _fail("注册表索引", f"collect_registry 结果异常: {list(reg)}")

    b = spec["bindings"][1]
    ok, typedef = resolve_custom_type(b, b["views"][0], reg)
    if not ok or typedef.get("id") != "partner_board" or typedef.get("className") != "PartnerBoard":
        _fail("类型解析", f"注册表命中异常: {ok}, {typedef}")

    # 旧写法兼容：viewType=custom + custom:true → 隐式注册项，类型键 = view.id
    legacy = yaml.safe_load((ROOT / "examples/partner_combo.yaml").read_text(encoding="utf-8"))
    legacy_reg = collect_registry(legacy)
    legacy_b = legacy["bindings"][1]
    ok2, td2 = resolve_custom_type(legacy_b, legacy_b["views"][0], legacy_reg)
    if not ok2 or td2.get("id") != "partner_card":
        _fail("兼容", f"旧 custom 写法退化异常: {td2}")

    # QWeb IR：自定义元素按注册表 tag 展开，props 补 default，children 递归
    node = qweb_ir.element_to_node(
        {"kind": "customElement", "ref": "status_badge", "props": {"state": "state"},
         "children": [{"kind": "field", "name": "name"}]},
        "form", {}, reg["viewElements"])
    s = qweb_ir.node_to_string(node)
    if not (s.startswith("<StatusBadge") and 'state="state"' in s and 'label="状态"' in s
            and '<field name="name"/>' in s):
        _fail("QWeb IR", f"customElement 展开异常: {s}")
    try:
        qweb_ir.element_to_node({"kind": "customElement", "ref": "nope"}, "form", {}, reg["viewElements"])
        _fail("QWeb IR", "未注册 ref 未抛错（违反不静默降级）")
    except ValueError:
        pass

    # 后端 B：注册项为权威（类型键 / 组件类 / services / tag / view_registry）
    files, actions, views = backend_b.binding_custom_records(
        b, module="dsl_custom_registry", registry=reg, view_elements=reg["viewElements"])
    js = dict(files)["static/src/js/partner_board_main.js"]
    xml = dict(files)["static/src/xml/partner_board_main.xml"]
    for needle in ("class PartnerBoard extends Component", "useService('rpc')",
                   "registry.category(\"views\").add('partner_board'", "static type = 'partner_board'"):
        if needle not in js:
            _fail("后端 B", f"JS 产物缺少 {needle}")
    if "<StatusBadge" not in xml or "<MetricTile" not in xml:
        _fail("后端 B", f"OWL 模板未展开自定义元素: {xml[:200]}")
    if views[0]["fields"]["type"] != "partner_board" or views[0]["arch"] != "<partner_board/>":
        _fail("后端 B", "ir.ui.view 的 type / arch 未用注册类型键")
    if actions[0]["fields"]["tag"] != "dsl_custom_registry.partner_board":
        _fail("后端 B", "client action tag 未取注册表 tag")

    # 顶层 client action
    recs = backend_a.explicit_action_records(spec["actions"], module="dsl_custom_registry")
    client = [r for r in recs if r["model"] == "ir.actions.client"][0]
    if client["fields"]["tag"] != "dsl_custom_registry.partner_board" or client["fields"]["params"] != {"defaultTab": "all"}:
        _fail("后端 A", f"client action 记录异常: {client['fields']}")

    # Composition：具名自定义类型进入 view_mode + act_window.view
    acts, awvs = backend_a.composition_action_records(
        spec["compositions"][0], module="dsl_custom_registry", id_map={},
        custom_view_xmlid={"partner_board_main": "dsl_custom_registry.view_partner_board_main"},
        custom_types=set(reg["viewTypes"]))
    if acts[0]["fields"]["view_mode"] != "list,partner_board" or not awvs:
        _fail("Composition", f"自定义类型未进入 view_mode: {acts[0]['fields']}")
    try:
        backend_a.composition_action_records(
            {"kind": "act_window", "id": "x", "model": "res.partner",
             "views": [{"viewType": "partner_board"}]},
            module="x", id_map={}, custom_view_xmlid={}, custom_types=set(reg["viewTypes"]))
        _fail("Composition", "缺 ref 的自定义视图未被拒绝（静默跳过）")
    except ValueError:
        pass
    _ok("生成器：注册表为权威、OWL 三件套/view_registry/client action/Composition 全打通，旧 custom 写法兼容")


# ── 4) 反向转换 ──
def test_round_trip() -> None:
    spec = _example()
    reg = collect_registry(spec)
    arch = ('<form><div class="o_board_tiles">'
            '<StatusBadge state="state" label="状态"/>'
            '<MetricTile value="partner_count" caption="伙伴总数"/>'
            '<field name="name"/></div></form>')
    back, warns = arch_to_spec(arch, module="t", model="res.partner", registries=reg)
    kids = back["bindings"][0]["views"][0]["elements"][0]["children"]
    if [k["kind"] for k in kids] != ["customElement", "customElement", "field"]:
        _fail("反向", f"自定义元素未还原: {kids}")
    if kids[0]["ref"] != "status_badge" or kids[0]["props"] != {"state": "state", "label": "状态"}:
        _fail("反向", f"ref / props 还原失真: {kids[0]}")
    if [t["id"] for t in back.get("viewTypes", [])] != ["partner_board"]:
        _fail("反向", "viewTypes[] 未写回产物")
    if _errors(back, _schema()):
        _fail("反向", f"产物未通过 schema: {_errors(back, _schema())[:2]}")
    regen = backend_a.binding_view_records(
        back["bindings"][0], module="t", view_elements=reg["viewElements"])[0]["arch"]
    if regen != arch:
        _fail("往返", f"正→反→正 arch 不一致: {regen}")

    raw, _ = arch_to_spec(arch, module="t", model="res.partner")
    kinds = [k["kind"] for k in raw["bindings"][0]["views"][0]["elements"][0]["children"]]
    if kinds[0] != "raw" or "viewElements" in raw:
        _fail("反向", "未提供 registries 时应退化为 raw 且不虚构注册表")
    _ok("反向：命中 tag → customElement、注册表原样写回、正→反→正逐字一致；无 registries 时保守退化")


# ── 5) 端到端 ──
def test_pipeline() -> None:
    with tempfile.TemporaryDirectory() as td:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            errs = pipeline.run(str(ROOT / "examples/custom_registry.yaml"), td)
        if errs:
            _fail("pipeline", f"样例生成 {errs} 个 error:\n{buf.getvalue()[-800:]}")
        out = Path(td) / "dsl_custom_registry"
        data_xml = (out / "views/dsl_generated.xml").read_text(encoding="utf-8")
        js = (out / "static/src/js/partner_board_main.js").read_text(encoding="utf-8")
        for needle in ('<field name="type">partner_board</field>',
                       '<field name="view_mode">list,partner_board</field>',
                       '<field name="tag">dsl_custom_registry.partner_board</field>',
                       'model="ir.actions.client"'):
            if needle not in data_xml:
                _fail("pipeline", f"data XML 缺少 {needle}")
        if 'registry.category("views").add(\'partner_board\'' not in js:
            _fail("pipeline", "OWL JS 未按注册类型键注册 view_registry")

        # 反向（带 registries）后再正向：闭环 0 error
        from oview.to_dsl import main as to_dsl_main
        rt = Path(td) / "rt.yaml"
        with contextlib.redirect_stderr(io.StringIO()):
            to_dsl_main([str(out / "views/dsl_generated.xml"), "--module", "rt_creg",
                         "--registries", str(ROOT / "examples/custom_registry.yaml"),
                         "--out", str(rt)])
        back = yaml.safe_load(rt.read_text(encoding="utf-8"))
        if _errors(back, _schema()):
            _fail("pipeline", f"反向产物未通过 schema: {_errors(back, _schema())[:2]}")
        if [t["id"] for t in back.get("viewTypes", [])] != ["partner_board"]:
            _fail("pipeline", "反向产物丢失 viewTypes[]")
        with contextlib.redirect_stdout(io.StringIO()):
            errs2 = pipeline.run(str(rt), str(Path(td) / "rt2"))
        if errs2:
            _fail("pipeline", f"反向产物再正向有 {errs2} 个 error")
    _ok("端到端：样例 pipeline 0 error，产物含自定义类型/元素/动作，正→反→正闭环成立")


def main() -> None:
    test_contract()
    test_registry_validation()
    test_generators()
    test_round_trip()
    test_pipeline()
    print("=== 全部通过 ===")


if __name__ == "__main__":
    main()
