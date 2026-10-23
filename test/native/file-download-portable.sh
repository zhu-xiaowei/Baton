#!/bin/sh
set -eu
plugin_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../../src-tauri/plugins/tauri-plugin-file-download" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
python3 - "$plugin_dir" "$test_dir" <<'PY'
import json
import pathlib
import shutil
import sys
import tomllib

plugin, target = map(pathlib.Path, sys.argv[1:])
config = tomllib.loads((plugin / "Cargo.toml").read_text())
dependencies = next(iter(config["target"].values()))["dependencies"]
dependencies["tokio"]["features"] += ["rt", "net", "io-util"]
manifest = '[package]\nname="file-download-portable"\nversion="0.1.0"\nedition="2021"\n[dependencies]\n'
for name, dep in dependencies.items():
    if isinstance(dep, str):
        dep = {"version": dep}
    values = [f"version = {json.dumps(dep['version'])}",
              f"features = {json.dumps(dep.get('features', []))}"]
    if "default-features" in dep:
        values.append(f"default-features = {json.dumps(dep['default-features'])}")
    manifest += name + " = { " + ", ".join(values) + " }\n"
(target / "Cargo.toml").write_text(manifest)
(target / "src").mkdir()
modules = ["filename", "desktop", "operations", "transfer"]
tests = plugin.parents[2] / "test/native/download-queue"
for name in modules:
    contents = "include!(" + json.dumps(str(plugin / "src" / (name + ".rs"))) + ");\n"
    if name != "filename":
        contents += "#[cfg(test)] include!(" + json.dumps(str(tests / (name + ".rs"))) + ");\n"
    (target / "src" / (name + ".rs")).write_text(contents)
(target / "src/lib.rs").write_text("#![allow(dead_code)]\n" + "\n".join(f"mod {name};" for name in modules))
shutil.copyfile(plugin.parent.parent / "Cargo.lock", target / "Cargo.lock")
PY
cargo test --manifest-path "$test_dir/Cargo.toml" "$@"
