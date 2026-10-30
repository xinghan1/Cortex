# DeepSeek account protocol

The Cortex account integration was written against DeepSeek's public
DeepSeek Harness account protocol and API documentation, inspected 2026-10-24:

- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek-account
- https://api-docs.deepseek.com/guides/anthropic_api/

DeepSeek Harness is Copyright (c) 2026 DeepSeek, licensed under MIT; its license is
included in this directory. Cortex uses its own implementation and product
identity. DeepSeek logos, UI assets and other applications' stored credentials
are not included.

The authorization flow uses the official platform's browser page, S256 PKCE and
a temporary loopback callback. Account grants are independent of API keys and
are encrypted by the operating system before being stored. Account grants are
sent only to the fixed official Platform and inference origins; HTTP redirects
are refused.
