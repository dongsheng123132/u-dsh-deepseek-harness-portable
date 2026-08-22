# 补充的许可证原文

这里放的是**上游包没有随包附带、由本项目按 SPDX 标准文本补上**的许可证全文。

为什么需要：有些包在 `package.json` 里正确声明了 `license`（例如 `Apache-2.0`、`MIT`），
但发布到 npm 的 tarball 里没有 `LICENSE` 文件。我们随发布包分发这些包的完整副本，
按其许可证仍需附上许可全文，所以在这里按声明的 SPDX 标识补一份标准文本。

- `Apache-2.0.txt` —— 取自闭包内 `@aws-crypto/sha256-browser` 随包的 LICENSE（Apache-2.0 标准全文，逐字一致）
- `MIT.txt` —— MIT 标准模板。**版权行留空并指向包自身仓库**，因为上游既没给
  LICENSE 也就没给版权归属，我们不代为编造一个版权人。

`third-party-licenses/NOTICES.md` 里，凡是用了这里文本的包都会**明确标注
「许可原文由 U-DSH 按 SPDX 标准文本补充（上游未随包提供）」**，不会伪装成上游原件。

要新增：只在「包声明了标准 SPDX 许可证、但 tarball 里确实没有原文」时补。
若包的 license 字段本身缺失、是 `UNLICENSED` 或 `SEE LICENSE IN ...`，
**不许用这里的模板糊过去** —— 那种必须逐个人工确认实际条款。
