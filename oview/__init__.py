"""Odoo View DSL —— 统一视图 DSL（元素→视图→视图类型绑定→组合）的生成器。

把规范 docs/dsl_qweb_owl_specification.md 的 IR 降低为：
  后端 A：标准视图 → ir.ui.view / ir.actions.act_window (Odoo data XML)
  后端 B：自定义视图 → OWL 组件三件套 (.js/.xml/.scss) + 注册
"""

__version__ = "0.1.0"
