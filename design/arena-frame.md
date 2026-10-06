# Arena frame: helium-sync CLI design sketch

Artifact: a design package (usage-first README + call sites, TypeScript type sketch with `not implemented` bodies, module map, rationale per rationale-template.md).

Rubric (picker only):
1. Caller experience: first device setup and second device join each <= 2 commands; steady-state sync needs zero or one command.
2. Correctness: no lost writes when the store is a dumb file-sync folder (iCloud/Dropbox/Syncthing); every sync is idempotent and crash-convergent.
3. Respects Helium's "modify only through Helium-defined APIs" README, or names exactly where and why it can't.
4. Extensibility: future frontends (extension UI, desktop app) and transports (S3, WebDAV, own server) plug in without engine rewrites; deep interfaces, wire/storage types private.
5. Type discipline: domain types and branded ids, illegal states unrepresentable, parse at boundaries.
6. YAGNI: smallest v1 surface that delivers 1-5.
