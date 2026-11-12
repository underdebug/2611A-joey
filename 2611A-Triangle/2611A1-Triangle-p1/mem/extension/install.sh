
#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! code --uninstall-extension local.mem; then
  echo "Uninstall failed; continuing with packaging and installation." >&2
fi

vsix="mem-$(node -p 'require("./package.json").version').vsix"
vsce package --no-dependencies --allow-missing-repository --skip-license --out "$vsix"
code --install-extension "$vsix" --force
