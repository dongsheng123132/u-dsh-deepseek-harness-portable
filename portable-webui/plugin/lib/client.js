window.__ModuleLoader__.load({
	id: "@u-dsh/dsh-client-ui-xiapan-wallet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const jsx_runtime = require("react/jsx-runtime");

		// 便携启动器把钱包面板固定起在这些端口（见 wallet-panel.cjs 的 PANEL_PORTS）
		const PANEL_PORTS = [43110, 43111, 43112, 43113, 43114];

		/**
		 * 打开钱包面板。优先用探测过的端口；探测失败就挨个试（面板没起时浏览器会显示连不上，
		 * 但至少不让点按无反应——终端里同时有提示）。
		 */
		function openPanel() {
			const probe = (port) =>
				new Promise((resolve) => {
					const timer = setTimeout(() => resolve(false), 800);
					fetch(`http://127.0.0.1:${port}/api/status`, { mode: "cors" })
						.then((res) => {
							clearTimeout(timer);
							resolve(res.ok);
						})
						.catch(() => {
							clearTimeout(timer);
							resolve(false);
						});
				});

			(async () => {
				for (const port of PANEL_PORTS) {
					if (await probe(port)) {
						window.open(`http://127.0.0.1:${port}/`, "_blank", "noopener");
						return;
					}
				}
				// 都没探测到：把第一个地址打开，用户至少能看到"连接被拒绝"而不是什么都没发生
				window.open(`http://127.0.0.1:${PANEL_PORTS[0]}/`, "_blank", "noopener");
			})();
		}

		/**
		 * 虾盘云钱包入口。静态渲染、不依赖任何异步状态：
		 * 组件在渲染期只读常量，点击时才联网，避免把 Web 客户端的 boot 拖下水
		 * （实测：组件里做 setState/fetch 会导致 dsh-client-ui-conversation 启动失败、整页白屏）。
		 */
		function XiapanWalletEntry() {
			return jsx_runtime.jsx("button", {
				type: "button",
				onClick: openPanel,
				title: "虾盘云设备钱包：看余额 / 一键充值 / 复制密钥",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					height: "26px",
					padding: "0 10px",
					borderRadius: "13px",
					border: "1px solid rgba(127,127,127,0.28)",
					background: "transparent",
					color: "inherit",
					font: "inherit",
					fontSize: "12px",
					cursor: "pointer",
					opacity: 0.9,
				},
				children: [
					jsx_runtime.jsx("span", {
						key: "dot",
						style: {
							width: "7px",
							height: "7px",
							borderRadius: "50%",
							background: "#2fa36b",
							display: "inline-block",
						},
					}),
					jsx_runtime.jsx("span", { key: "text", children: "虾盘云 · 余额/充值" }),
				],
			});
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.bar", () =>
				ctx.slots.register({ name: "conversation.composer.bar", id: "xiapan-wallet" }, XiapanWalletEntry),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
