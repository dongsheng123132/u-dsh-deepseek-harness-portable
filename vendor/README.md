# Vendored development components

U-DSH vendors ActionParity 0.7.0 because the SDK is not yet available from the
public npm registry. The copy comes from commit
`cfb787ce6b24496bce1b84364d5da8006cec6846` of
<https://github.com/dongsheng123132/action-parity>.

- `action-parity-sdk/` is required at runtime by the shared Action Core.
- `action-parity-tool/` is a development-only generator and verifier.
- Both are provided under Apache-2.0; their license files are preserved inside
  each directory.

Replace these directories atomically when upgrading. Do not edit generated
files in `generated/` by hand.
