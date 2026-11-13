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
