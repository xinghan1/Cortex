ZCode upstream source fixture

Copyright 2026 Z.AI Co., Ltd.
Licensed under the Apache License, Version 2.0. The full upstream license is
retained in zcode-v0170-LICENSE in this directory.

zcode-protocol-entrypoint-v0170.ts is an unmodified source fixture from:
https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts

Pinned revision: 3c5b227649371507ddc4eb46ac5133afe6db1cab
CLI version: 0.17.0

It is retained only to test the exact upstream initialization and compatibility
patch. Its contents are unchanged; line endings may be normalized to LF for
digest verification. Synora's changes are in
scripts/patches/zcode-standalone-account.mjs, not in this baseline fixture.

The same pinned Apache-2.0 source revision supplies two unmodified model contract
fixtures used to execute the upstream model-option mapper and selection validator:

- zcode-provider-registry-v0170.ts: packages/provider/src/registry.ts
- zcode-provider-registry-selection-v0170.ts:
  apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts

The upstream NOTICE.md and complete third-party notices are retained alongside
the distributed component in src/vendor/zcode-agent/.
