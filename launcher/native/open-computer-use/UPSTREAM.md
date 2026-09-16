# Vendored native Computer Use runtime

This directory contains the Windows native executables from `open-computer-use@0.3.4`.
The package is published at https://www.npmjs.com/package/open-computer-use and its source is
available at https://github.com/iFurySt/open-codex-computer-use.

The binaries are vendored under the package's MIT license so the Codex Web GPT installer can
configure native desktop controls without requiring users to install Node.js or npm. The launcher
registers the executable with Codex as `open-computer-use mcp` and only uses the matching Windows
CPU architecture.

SHA-256:

- `win32-x64/open-computer-use.exe`: `14692EF7B4556D9EE75014DECD9C2B2358664ECD37858B1322B70B5BD79409EE`
- `win32-arm64/open-computer-use.exe`: `0AEBAC2F3816E3BC253D39170E2D3E3DB2A2CCAD36663F393FA906B51E80CF08`
