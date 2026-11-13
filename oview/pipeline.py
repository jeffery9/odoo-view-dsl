"""生成管线：加载 DSL 规格 → 校验(IR 快筛 + RNG 终审) → 生成(后端A/B) → 落盘。

链路：dsl_validate(快筛) → 生成 arch → rng_validate(终审) → 写文件。
"""
from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

# vendored 校验器（独立脚本，按路径 import）
_VALIDATOR_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "validator")
if _VALIDATOR_DIR not in sys.path:
    sys.path.insert(0, _VALIDATOR_DIR)
import dsl_validate  # type: ignore
import rng_validate  # type: ignore

from . import backend_a, backend_b
from .model import load_spec, normalize_binding

# 指向完整 Odoo 树以启用 RNG 终审（缺文件时 rng_validate 自动降级 skip）
DEFAULT_RNG_DIR = "/Users/jeffery/_project/topdon/USA/odoo-15.0.post20250115/odoo/addons/base/rng"


def _emit_issues(log: List[str], label: str, issues: List[Any]) -> int:
    errors = sum(1 for i in issues if getattr(i, "severity", "info") == "error")
    if not issues:
        log.append(f"  [OK] {label}")
    else:
        log.append(f"  [{errors}E] {label}")
        for i in issues:
            log.append(f"       - {getattr(i,'severity','?'):>5} {getattr(i,'code','?')}: {getattr(i,'message','')}")
    return errors


def run(spec_path: str, out_dir: str, module: str = "dsl_gen",
        rng_dir: str = DEFAULT_RNG_DIR) -> int:
    spec = load_spec(spec_path)
    bindings = spec.get("bindings", [])
    compositions = spec.get("compositions", [])
    module = spec.get("module") or module
    log: List[str] = []
    total_errors = 0

    # 1) IR 快筛（每个 binding）
    log.append("◆ DSL IR 快筛 (dsl_validate)")
    for b in bindings:
        b = normalize_binding(b)
        issues = dsl_validate.validate_binding(b, rng_dir=rng_dir)
        total_errors += _emit_issues(log, f"binding {b.get('model')}/{b.get('viewType')}", issues)

    # 2) 生成后端 A（标准视图记录）；自定义 binding 交给后端 B，此处跳过
    log.append("◆ 后端 A 生成 (标准视图 → ir.ui.view / act_window)")
    view_records: List[Dict] = []
    id_map: Dict[Tuple[int, str], str] = {}
    for bi, b in enumerate(bindings):
        b = normalize_binding(b)
        if b.get("custom") or any(
            (v.get("viewType") == "custom" or v.get("custom")) for v in b.get("views", [])
        ):
            continue  # 自定义视图不产 ir.ui.view，由后端 B 处理
        recs = backend_a.binding_view_records(b, module=module)
        for r, v in zip(recs, b.get("views", [])):
            view_records.append(r)
            id_map[(bi, v["id"])] = r["xml_id"]

    # 3) 生成后端 B（自定义视图 → OWL 三件套 + action 记录）
    log.append("◆ 后端 B 生成 (自定义视图 → OWL 组件)")
    custom_files: List[Tuple[str, str]] = []
    custom_actions: List[Dict] = []
    for bi, b in enumerate(bindings):
        b = normalize_binding(b)
        if b.get("custom") or any((v.get("viewType") == "custom" or v.get("custom")) for v in b.get("views", [])):
            files, actions = backend_b.binding_custom_records(b, module=module)
            custom_files.extend(files)
            custom_actions.extend(actions)
    if custom_files:
        log.append(f"  [OK] {len(custom_files)} 个 OWL 文件 + {len(custom_actions)} 个客户端 action")

    # 4) Composition → action 记录
    log.append("◆ Composition 生成 (act_window / dashboard)")
    action_records: List[Dict] = []
    awv_records: List[Dict] = []
    for c in compositions:
        acts, awvs = backend_a.composition_action_records(c, module=module, id_map=id_map)
        action_records.extend(acts)
        awv_records.extend(awvs)

    # 5) 汇总并写 data XML
    all_records = view_records + action_records + awv_records + custom_actions
    out_path = Path(out_dir) / module / "views" / "dsl_generated.xml"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    xml = backend_a.render_data_xml(all_records)
    out_path.write_text(xml, encoding="utf-8")
    log.append(f"  [OK] 写出 {out_path} ({len(all_records)} 条记录)")

    # 6) 写自定义 OWL 文件
    for rel, content in custom_files:
        p = Path(out_dir) / module / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    # 7) RNG 终审（仅对标准 primary arch）
    log.append("◆ RNG 终审 (rng_validate，仅标准 primary)")
    rng_checked = 0
    for r in view_records:
        if r.get("inherit"):  # extension arch 由 Odoo 运行时合并，跳过 RNG
            continue
        vtype = r["fields"].get("type")
        res = rng_validate.validate_arch(r["arch"], view_type=vtype, rng_dir=rng_dir)
        rng_checked += 1
        if res.issues:
            total_errors += _emit_issues(log, f"{r['xml_id']} ({vtype})", res.issues)
        else:
            status = "SKIP" if res.skipped else "OK"
            log.append(f"  [{status}] {r['xml_id']} ({vtype})")
    log.append(f"  (RNG 已检 {rng_checked} 个 arch)")

    print("\n".join(log))
    print(f"\n=== 结果：{total_errors} 个 error ===")
    return total_errors


def main(argv: List[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Odoo 统一视图 DSL 生成器")
    ap.add_argument("spec", help="DSL 规格文件 (.yaml 为主；.json 兼容)")
    ap.add_argument("--out", default="outputs", help="输出目录")
    ap.add_argument("--module", default="dsl_gen", help="生成模块名")
    ap.add_argument("--rng-dir", default=DEFAULT_RNG_DIR, help="Odoo base/rng 目录")
    args = ap.parse_args(argv)
    return run(args.spec, args.out, module=args.module, rng_dir=args.rng_dir)


if __name__ == "__main__":
    raise SystemExit(main())
