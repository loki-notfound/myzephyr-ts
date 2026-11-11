#!/usr/bin/env bash
# CMake compiler launcher: run each compile from $RELPATH_ROOT with paths relative to it, so
# that clang 15 (Emscripten 3.1.10) records no absolute host path in lambda names inside
# __PRETTY_FUNCTION__ strings, which -ffile-prefix-map does not cover in this clang version.
# Response files (@file, relative to the build directory) are expanded and rewritten; output
# and dependency-file paths given relative to the build directory are re-anchored to the root.
exec python3 -I -c '
import os, shlex, sys
root = os.environ["RELPATH_ROOT"].rstrip("/") + "/"
cwd = os.getcwd() + "/"
relcwd = cwd[len(root):] if cwd.startswith(root) else None
if relcwd is None: os.execvp(sys.argv[1], sys.argv[1:])  # outside the root: unchanged
def rel(a): return a.replace(root, "")
out, args, i = [], sys.argv[1:], 0
while i < len(args):
    a = args[i]
    if a.startswith("@") and os.path.isfile(a[1:]):
        out += [rel(x) for x in shlex.split(open(a[1:]).read())]
    elif a in ("-o", "-MF") and i + 1 < len(args):
        p = args[i + 1]; out += [a, rel(p) if p.startswith("/") else relcwd + p]; i += 1
    else:
        out.append(rel(a))
    i += 1
os.chdir(root)
os.execvp(out[0], out)
' "$@"
