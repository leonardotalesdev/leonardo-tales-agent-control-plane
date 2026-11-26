# Package provenance

On 26 November 2026, the npm tarball for each pinned dependency was downloaded independently of its GitHub Release asset. A byte comparison matched in both cases. SHA-512 values matched the release records and the npm lockfile's integrity values. `npm ci` verifies the archives against that lockfile.

| Package | Tagged source commit | Archive SHA-512 |
| --- | --- | --- |
| `@leonardo-tales/action-gateway@0.2.0` | `2fe0f0a992ff336bca22a738ad310e429ee56917` | `cde68c8523a4f21b8844e54603ac8f3b35d4d462eea710878ea41dd6b07b9a01a3f0109710989d967a0de4495c5605be1eb2960a2dbd953558657e79c40b4b0b` |
| `@leonardo-tales/policy-engine@0.3.0` | `85764269002a23407572e61e2884c6d47b80451a` | `1ca18bb87dab4bf065640b9833373c1f7e6983173a00a5d9550f16123e9ad3520a894519036779f17e55241939f9d081a7ec0e83eaf7aed8f5e9825edef37aaa` |

- Action Gateway. [GitHub Release](https://github.com/leonardotalesdev/leonardo-tales-action-gateway/releases/tag/v0.2.0) · [npm metadata](https://registry.npmjs.org/@leonardo-tales%2faction-gateway/0.2.0)
- Policy Engine. [GitHub Release](https://github.com/leonardotalesdev/leonardo-tales-policy-engine/releases/tag/v0.3.0) · [npm metadata](https://registry.npmjs.org/@leonardo-tales%2fpolicy-engine/0.3.0)
