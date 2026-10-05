# Release checklist — dsh-team-crew

Packed release tarballs (`local-dsh-team-crew-*.tgz`) are build artifacts and are
NOT committed to the repository. Version history lives in git tags.

## Cut a release

1. Bump `version` in `package.json`.
2. Run the offline suites against the WORKSPACE source:
   - `node team-crew-harness.mjs` (Host half, 90 checks)
   - `node team-crew-client-probe.mjs` (Client half, 33 checks)
   - `node team-crew-persistence-probe.mjs` (storage stack, 8 checks)
3. `npm pack` → `local-dsh-team-crew-<version>.tgz`.
4. Install the tgz via the DSH plugin manager (`plugin_manager install_bundle`),
   restart DSH, verify the tools and the desk live, then tag:

```sh
git tag v<version>
git push origin v<version>
```

## Never commit

- `local-dsh-team-crew-*.tgz` (see .gitignore)
- machine-local paths beyond the documented install locations
