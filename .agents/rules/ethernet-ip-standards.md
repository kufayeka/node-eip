# @kufayeka/ethernet-ip Standards & Best Practices

See `.agents/skills/odva-cip-compliance/SKILL.md` first for the protocol reference and
architecture map this file assumes. These are the concrete, mechanical rules for working in
this specific repo.

1. **Test discipline**:
   - Run `npm test` (Mocha, `test/**/*_spec.js`) before starting work and again before every
     commit. 300+ tests exist specifically to catch protocol regressions.
   - A single test failing intermittently under system load (timing-sensitive `setTimeout`-based
     Class 1 I/O tests) is a known characteristic of this suite, not automatically a real bug —
     re-run in isolation (`npx mocha --exit test/<file>_spec.js`) before concluding it's flaky vs. real.
   - New protocol behavior gets a new test, ideally one that would have caught the bug you're
     fixing. Cite what the test verifies against (an OpENer function, an ODVA publication section,
     a real device's own EDS/manual) in the test's `describe`/`it` text, not just in the commit message.

2. **Identity / Revision consistency**:
   - `DeviceBuilder`'s constructed identity and `eds-exporter.js`'s generated EDS text must always
     agree on `revision.major`/`revision.minor` (both clamped to `[1, 255]` — ODVA's EDS spec
     forbids 0). If you add another code path that constructs an `IdentityObject` or generates EDS
     text, apply the identical clamp; a mismatch causes real Scanners using compatible keying to
     reject every Forward_Open with a Revision mismatch (0x0116) — this exact bug was reproduced
     live and fixed once already.
   - Bumping `revision` (or `productCode`) is the standard workaround when a real PLC's config
     software has cached an old device library entry and won't pick up EDS changes otherwise.

3. **EDS generation (`src/device/eds-exporter.js`)**:
   - Every generated field's format must be checked against a real, working EDS before being
     trusted — either this project's own real Delta SX3 EDS (`eds/031F000E0F0600010001.eds`) or
     another vendor's real EDS. Do not invent field encodings from spec-reading alone; the Param
     Descriptor bitmap bug (wrong bits used for read/write access) and the Data Type hex-width bug
     (4 hex digits instead of 2) both happened this way and went unnoticed by this project's own
     round-trip tests because the bug was symmetric on import/export — only a real external parser
     (Delta EIP Builder) caught them.
   - A Tag Connection's (`SYMBOL_ANSI` path) Format field should reference a real Assembly built
     from Param members when numeric tags exist, matching the real SX3 EDS's own pattern — don't
     leave it blank.

4. **Connection Manager (`src/adapter/connection-handler.js`)**:
   - Any new Forward_Open branch (explicit / numeric Assembly / symbolic tag) must run through
     `_checkElectronicKey()` and the duplicate-connection check (`strictDuplicateConnections`)
     before opening — don't special-case a new path type around them.
   - Production timing changes must go through `_startProducer()` (shared by numeric and tag
     connections) — don't add a second, parallel `setInterval`-based producer.
   - When caching a Buffer for later comparison (e.g. Change-of-State's "did the data change"
     check), always snapshot with `Buffer.from(buf)` — `AssemblyObject.getData()` and similar
     accessors return the SAME live buffer on every call, mutated in place, so caching the reference
     directly makes every future comparison compare the buffer to itself. This exact bug shipped
     once in this file's Change-of-State logic before being caught by a flaky-looking test.

5. **Vendor neutrality**:
   - `src/cip/` and `src/encapsulation/` stay vendor-neutral — no `if (vendor === '...')` branches.
   - Vendor-specific behavior goes in `src/vendors/<vendor>/` (Scanner-side `DeviceProfile`, see
     `docs/VENDOR_GUIDE.md`) or as an additive registered CIP object class (Adapter-side, e.g.
     `src/cip/objects/delta-registers.js`) that other vendors simply never register.

6. **Commits**:
   - Confirm with the user before `git push origin main` (this repo has no branch-protection
     workflow of its own; the push itself is the gate).
   - Commit messages explain *why*, not just *what* — especially for protocol bugs, name the real
     symptom (extended status code, real device behavior observed) that led to the fix, not just the
     code change. Future debugging sessions grep commit history for exact status codes.
   - End commit messages with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (or the
     current model's equivalent line) when an AI assistant made the change.
