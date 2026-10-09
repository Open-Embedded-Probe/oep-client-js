# Isolated JavaScript test environment

Use Node 22 or newer, npm and uv. The virtual OEP backend is pinned by commit in `test/virtual-bench/pyproject.toml` and by `uv.lock`, installed into this repository's own environment. Tests do not search sibling checkouts or equipment inventories.

```sh
npm ci
uv sync --project test/virtual-bench --locked
OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
```

An explicitly selected Python missing the virtual module is a preparation error. `OEP_REQUIRE_VIRTUAL_BENCH=1` also makes the dependency mandatory. With neither setting, tests use `python3` and may skip optional virtual integration cases if the backend is absent; this does not complete release verification.

CI, Pages and Release use the same setup action and require the pinned backend. Update its commit and lock together, then verify integration, types and distribution artifacts. This test dependency does not impose a minimum physical probe firmware version. Virtual success does not certify physical USB operation or firmware transfers.
