/** @odoo-module alias=dsl_custom_demo.partner_card */
import { Component } from "@odoo/owl";
import { useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { registry } from "@web/core/registry";

// 自定义视图组件：props 来自 action context / env services（非 recordset 绑定）
export class PartnerCard extends Component {
    setup() {
        this.state = useState({});
        this.rpc = useService('rpc');
        this.notification = useService('notification');
        // prop: partnerId
        // A1–A9 无障碍：Esc 关闭骨架
        this.env.bus.on("keydown", this, (ev) => {
            if (ev.key === "Escape") this._onClose();
        });
    }
    _onClose() {
        // 由具体业务决定是否关闭；此处保留挂钩
    }
}
PartnerCard.template = 'dsl_custom_demo.partner_card';
// 注册为客户端 action（替代手写 view_registry 字符串游离）
registry.category("actions").add('dsl_custom_demo.partner_card', PartnerCard);
