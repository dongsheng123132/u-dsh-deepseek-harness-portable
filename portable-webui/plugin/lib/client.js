window.__ModuleLoader__.load({
	id: "@u-dsh/dsh-client-ui-xiapan-wallet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const jsx = require("react/jsx-runtime");
		const react = require("react");

		// 便携启动器把钱包面板固定起在这个端口（见 wallet-panel.cjs 的 PANEL_PORTS）
		const PANEL_PORT = 43110;
		const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`;

		const styles = `
			.udsh-wallet-btn {
				display: inline-flex; align-items: center; gap: 6px;
				height: 26px; padding: 0 10px; margin: 0;
				border: 1px solid rgba(127,127,127,0.28); border-radius: 13px;
				background: transparent; color: inherit; font: inherit; font-size: 12px;
				cursor: pointer; opacity: 0.92; white-space: nowrap;
			}
			.udsh-wallet-btn:hover { background: rgba(127,127,127,0.12); opacity: 1; }
			.udsh-wallet-btn[data-empty="true"] { border-color: rgba(214,148,0,0.6); color: #c08a00; }
			.udsh-wallet-btn .udsh-wallet-sign { font-weight: 600; }
		`;

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-client-ui-xiapan-wallet"]')) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-client-ui-xiapan-wallet";
			tag.dataset.pluginCss = "dsh-client-ui-xiapan-wallet";
			tag.textContent = styles;
			document.head.appendChild(tag);
		}

		/**
		 * 左下角钱包入口（sidebar.footer.action 插槽）。
		 * 契约照抄 dsh-workspace-terminal：插槽传 { wide } 决定是否显示文字。
		 */
		/** 余额（元）读本地钱包面板；面板没起/断网就显示 null，按钮照常可点。 */
		function useBalance() {
			const [available, setAvailable] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const read = () => {
					fetch(`${PANEL_URL}api/status?balance=1`, { mode: "cors" })
						.then((res) => (res.ok ? res.json() : null))
						.then((data) => {
							if (!alive || !data?.balance) return;
							if (typeof data.balance.available === "number") setAvailable(data.balance.available);
						})
						.catch(() => {});
				};
				read();
				const timer = setInterval(read, 60000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			return available;
		}

		/**
		 * 左下角钱包入口（sidebar.footer.action 插槽）。
		 * 契约照抄 dsh-workspace-terminal：插槽传 { wide } 决定是否显示文字。
		 */
		function WalletAction(props) {
			const wide = props?.wide !== false;
			const available = useBalance();
			const yuan = available == null ? null : available / 500000;
			const empty = available != null && available <= 1;
			const label = yuan == null ? "虾盘云钱包" : `虾盘云 ¥${yuan.toFixed(2)}`;
			const open = () => {
				window.open(PANEL_URL, "_blank", "noopener");
			};
			const children = [jsx.jsx("span", { key: "sign", className: "udsh-wallet-sign", children: "¥" })];
			if (wide) children.push(jsx.jsx("span", { key: "label", children: label }));
			return jsx.jsx("button", {
				type: "button",
				className: "udsh-wallet-btn",
				title: empty
					? "余额为 0：点这里打开虾盘云钱包充值"
					: "虾盘云设备钱包：看余额 / 一键充值 / 复制密钥",
				"data-udsh-wallet": true,
				"data-empty": empty ? "true" : "false",
				onClick: open,
				children,
			});
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "xiapan-wallet", order: 25 }, WalletAction),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
