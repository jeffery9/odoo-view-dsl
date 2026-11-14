#!/usr/bin/env python3
"""DSL schema 校验脚本：证明 schema/dsl_schema.yaml（默认）/dsl_schema.json 是自洽的、
能放行合法样例、并拦截非法 DSL。

YAML 与 JSON 两份 schema 字节级等价（由 JSON 程序化转储，round-trip 一致），
校验逻辑二者通用。脚本默认优先加载 YAML 版（与项目「YAML 主语言」定位一致），
缺失时回退 JSON 版。

用法：
  python3 schema/validate.py                 # 校验 examples/ 下全部样例 + 反例
  python3 schema/validate.py <file.yaml>...   # 校验指定文件
  python3 schema/validate.py --schema schema/dsl_schema.json  # 指定 schema
依赖：jsonschema（pip install jsonschema）、pyyaml（pip install pyyaml）
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "schema"
EXAMPLES_DIR = ROOT / "examples"

# 默认优先 YAML（主语言），回退 JSON；可用 --schema 显式指定
def _resolve_schema(path_arg=None) -> Path:
    if path_arg:
        return Path(path_arg)
    for cand in ("dsl_schema.yaml", "dsl_schema.json"):
        p = SCHEMA_DIR / cand
        if p.exists():
            return p
    return SCHEMA_DIR / "dsl_schema.yaml"

SCHEMA_PATH = _resolve_schema(os.environ.get("DSL_SCHEMA"))


def _load_schema(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        return yaml.safe_load(text)
    return json.loads(text)


_schema = _load_schema(SCHEMA_PATH)
# 自洽检查：schema 本身必须是合法 Draft 2020-12 文档
Draft202012Validator.check_schema(_schema)
VALIDATOR = Draft202012Validator(_schema)


def load(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        return yaml.safe_load(text)
    return json.loads(text)


def errors_of(doc) -> list:
    return sorted(VALIDATOR.iter_errors(doc), key=lambda e: list(e.path))


def check_example(path: Path) -> bool:
    doc = load(path)
    errs = errors_of(doc)
    if errs:
        print(f"  [FAIL] {path.name}: {len(errs)} 处结构错误")
        for e in errs[:8]:
            loc = "/".join(str(p) for p in e.path) or "<root>"
            print(f"        - {loc}: {e.message}")
        return False
    print(f"  [PASS] {path.name}: 结构合法")
    return True


# ── 反例：必须被 schema 拦截，证明校验非 no-op ──
def _slice_case(slice_view: dict) -> dict:
    """构造含 1 个 primary 基础层 + 1 个切片层的合法骨架，只让切片本身出问题。"""
    return {"module": "x", "bindings": [{
        "model": "sale.order", "viewType": "form",
        "views": [
            {"id": "base", "mode": "primary", "elements": []},
            slice_view,
        ]}]}


COUNTER_CASES = {
    "缺 module/bindings": {},
    "field 缺 name": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "field"}]}]}],
    },
    "未知 kind（拼写漂移 field→fild）": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "fild", "name": "x"}]}]}],
    },
    "extension 缺 inherit": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "mode": "extension", "elements": []}]}],
    },
    "raw 缺 reason": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "raw", "qweb": "<b/>"}]}]}],
    },
    "dynamicAttr 缺 value": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "dynamicAttr", "attr": "class"}]}]}],
    },
    "顶层多余键": {
        "module": "x", "bindings": [], "bogus_key": 1},
    # ── 切片层契约（§4.1/§6.6）──
    "切片 xpath 为空": _slice_case({
        "id": "s", "mode": "extension", "inherit": "base",
        "patches": [{"xpath": "", "position": "after",
                     "elements": [{"kind": "field", "name": "x"}]}]}),
    "切片 position=attributes 缺 attrs": _slice_case({
        "id": "s", "mode": "extension", "inherit": "base",
        "patches": [{"xpath": "//field[@name='x']", "position": "attributes"}]}),
    "切片 position=attributes 混用 elements": _slice_case({
        "id": "s", "mode": "extension", "inherit": "base",
        "patches": [{"xpath": "//field[@name='x']", "position": "attributes",
                     "attrs": [{"name": "invisible", "value": "1"}],
                     "elements": [{"kind": "field", "name": "y"}]}]}),
    "切片 position=after 带 attrs": _slice_case({
        "id": "s", "mode": "extension", "inherit": "base",
        "patches": [{"xpath": "//field[@name='x']", "position": "after",
                     "elements": [{"kind": "field", "name": "y"}],
                     "attrs": [{"name": "invisible", "value": "1"}]}]}),
    "primary 带 patches": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "mode": "primary", "elements": [],
                       "patches": [{"xpath": "//field[@name='x']", "position": "after",
                                    "elements": []}]}]}],
    },
    "extension 带 elements（会被生成器静默丢弃）": _slice_case({
        "id": "s", "mode": "extension", "inherit": "base",
        "elements": [{"kind": "field", "name": "x"}]}),
    # ── 结构条契约（§6.5）：children 必填，否则 arch 里是空壳 <header>/<footer> ──
    "header 缺 children": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "header"}]}]}],
    },
    "footer 缺 children": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [
                {"kind": "group", "children": []}, {"kind": "footer"}]}]}],
    },
    # ── div / label：类型约束与 children 递归校验 ──
    "label colspan 非整数": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "label", "colspan": "two"}]}]}],
    },
    "div.children 内未知 kind": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [
                {"kind": "div", "children": [{"kind": "fild", "name": "x"}]}]}]}],
    },
    # ── 自定义注册表契约（§2.1）：先声明后引用，缺必填字段必须被拦截 ──
    "customElement 缺 ref": {
        "module": "x", "bindings": [{
            "model": "sale.order", "viewType": "form",
            "views": [{"id": "v", "elements": [{"kind": "customElement"}]}]}],
    },
    "viewTypes 注册项缺 id": {
        "module": "x", "viewTypes": [{"name": "看板"}],
        "bindings": [{"model": "sale.order", "viewType": "form",
                      "views": [{"id": "v", "elements": []}]}],
    },
    "viewTypes 注册项 id 非法": {
        "module": "x", "viewTypes": [{"id": "1_bad-type"}],
        "bindings": [{"model": "sale.order", "viewType": "form",
                      "views": [{"id": "v", "elements": []}]}],
    },
    "viewElements props 项缺 name": {
        "module": "x", "viewElements": [{"id": "badge", "props": [{"required": True}]}],
        "bindings": [{"model": "sale.order", "viewType": "form",
                      "views": [{"id": "v", "elements": []}]}],
    },
    "client action 缺 tag": {
        "module": "x", "actions": [{"id": "open_board", "type": "client"}],
        "bindings": [{"model": "sale.order", "viewType": "form",
                      "views": [{"id": "v", "elements": []}]}],
    },
    "url action 缺 url": {
        "module": "x", "actions": [{"id": "docs", "type": "url"}],
        "bindings": [{"model": "sale.order", "viewType": "form",
                      "views": [{"id": "v", "elements": []}]}],
    },
}


def check_counter(name: str, doc: dict) -> bool:
    errs = errors_of(doc)
    if errs:
        print(f"  [PASS] 反例「{name}」被拦截（{len(errs)} 处）")
        return True
    print(f"  [FAIL] 反例「{name}」未被拦截（schema 形同虚设）")
    return False


def main(argv) -> int:
    ok = True
    files = []
    schema_arg = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--schema":
            schema_arg = argv[i + 1]
            i += 2
            continue
        files.append(Path(a))
        i += 1

    # 若用户用 --schema 指定了不同文件，重建校验器
    global SCHEMA_PATH, VALIDATOR
    if schema_arg:
        SCHEMA_PATH = _resolve_schema(schema_arg)
        _schema = _load_schema(SCHEMA_PATH)
        Draft202012Validator.check_schema(_schema)
        VALIDATOR = Draft202012Validator(_schema)

    print(f"◆ 使用 schema：{SCHEMA_PATH.name}")
    print("◆ schema 自洽性：通过 (Draft 2020-12)")

    if files:
        pass
    else:
        files = sorted(EXAMPLES_DIR.glob("*.yaml"))

    print(f"\n◆ 合法样例校验（{len(files)} 个）")
    for f in files:
        ok &= check_example(f)

    print("\n◆ 反例拦截（证明 schema 非 no-op）")
    for name, doc in COUNTER_CASES.items():
        ok &= check_counter(name, doc)

    print("\n=== 结果：", "全部通过" if ok else "存在失败", "===")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
