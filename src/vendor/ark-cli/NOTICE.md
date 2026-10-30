# Ark CLI integration notice

Cortex bundles the original native executable distributed by the official npm package `@volcengine/ark-cli`, version **1.0.42**. The official CLI executable is unmodified.

- Package: [@volcengine/ark-cli 1.0.42](https://www.npmjs.com/package/@volcengine/ark-cli/v/1.0.42)
- Upstream repository: [volcengine/ark-cli](https://github.com/volcengine/ark-cli)
- License: Apache License 2.0. The accompanying `LICENSE` is the unmodified [upstream LICENSE](https://raw.githubusercontent.com/volcengine/ark-cli/main/LICENSE), retrieved on 2026-10-26. No project-specific copyright attribution has been invented or added to that text.

The native download URLs and expected SHA-256 values come from the pinned npm package's `manifest.json`. For Windows x64:

```text
asset: arkcli-1.0.42-windows-amd64.exe
SHA-256: c0bc8dc957b7c6da9c77b971c81b9813b2e75dce32dc1044bc2dff50bd61797a
```

The manifest points to the official [CDN asset](https://lf3-static.bytednsdoc.com/obj/eden-cn/psjryh/ljhwZthlaukjlkulzlp/prod/1.0.42/arkcli-1.0.42-windows-amd64.exe), with an official [GitHub release fallback](https://github.com/volcengine/ark-cli/releases/download/v1.0.42/arkcli-1.0.42-windows-amd64.exe). The official installer, Cortex build preparation, and account runtime verify the manifest digest. Cortex does not rewrite or patch the CLI authentication implementation.

Cortex runs official browser authorization in an application-specific home directory. After the user explicitly chooses an official Profile, the documented `profile apikey get --profile <name> --plain` interface supplies that Profile's runtime Key locally to Cortex's main process for encrypted storage. Raw credentials are not exposed to the renderer. Cortex does not read CLI credential files or extract SSO tokens or browser cookies.

Profile, region, identity and billing-scope handling are described in `docs/ARK_ACCOUNT.md`. This file documents Cortex's integration; it is not represented as an upstream-authored NOTICE.
