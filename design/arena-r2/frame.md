# Arena round 2 frame: helium-sync as an MV3 extension

Artifact: design package (usage-first DESIGN.md per rationale-template.md + TypeScript sketch with `not implemented` bodies that passes `tsc --strict`).

Fixed inputs: design/grounding.md (rounds 1 and 2). Round-1 synthesis (CLI-first) at design/arena-r1/DESIGN-cli-synthesis.md and sketch-cli-synthesis/: its register layer, per-device store files, fold rule, adoption, ports, and Store contract are proven by P3 and should be reused unless the extension runtime breaks them.

Rubric (picker only):
1. Experience: install from CWS + setup on device 1 and device 2 each take under a minute with no terminal; steady state is zero actions; the user can see sync state.
2. Correctness: no lost writes on the chosen store; every sync idempotent and crash-convergent under MV3 service-worker termination.
3. Default mode uses only Helium/Chrome extension APIs; opt-in file mode is a clean, isolated addition, not a branch spread through the engine.
4. History as type 2 fits without bloating sync (sharding) and without corrupting local history.
5. Type discipline and deep interfaces; wire/storage types private.
6. YAGNI: smallest v1 that delivers 1-5.
