# Unified GS integration test artifact

`apps-script/UnifiedCode.gs` is a generated **isolated-test-only** full bundle. It combines the complete VSBADGE v9.6 baseline with the complete VSPORTAL v2.8.8 compatibility module and Unified router. It is kept outside the Vercel static deployment package and is **not a production/deployed GS**. Do not replace the live Apps Script with this artifact unless its release status is separately authorized and verified.

The repository-root `apps-script/Code.gs` remains the VSBADGE baseline and is not overwritten. This full bundle is stored separately so the shorter baseline cannot be mistaken for the complete shared backend.

Build/test locally:

```sh
npm run test:unified
```

Pinned inputs:
- VSBADGE baseline: `playerkousas-rgb/vsbadge@87c76a98b95ff7b5e2a7be02198142c72aefc24e`; `apps-script/Code.gs` at merge commit, SHA-256 `63148a32095694a92a45d9fa14fc190b7fd8e35336080d2c48ad9adf61c34a10`.
- VSPORTAL source: `playerkousas-rgb/vs_portal@41b923a1eafe56f7b2b572fc9e43d24b975f6db6`; complete `apps-script/Code.gs` compatibility source, SHA-256 `f0047c279e8c3ec2bbfd6cfb34e140e661e3dcd0caa342fc07e06838cef05293`.
- Portal build channel remains `isolated-test-only`; this copy does not publish or deploy it.
- Generated bundle: 8,939 lines / 523,476 bytes, SHA-256 `0c9d243a1535cc4cd3a9336b64580303a1456b85885795eb244e40a556a685f9`.
- Unified contract suite: 92 passed, 0 failed; VSBADGE suite: 173 passed, 0 failed.
