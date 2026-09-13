# Contributing

Thanks for considering a contribution. This is a reference tool for the RISC-V
community, so correctness matters more than speed: a wrong dependency or a
malformed `-march` string is worse than a missing feature, because it looks
right.

## Developer Certificate of Origin

Every commit must be signed off. This project uses the
[Developer Certificate of Origin](DCO) (DCO 1.1), the same mechanism the Linux
kernel and Linux Foundation projects use. There is no CLA to sign.

Signing off adds one line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Git will add it for you:

```bash
git commit -s -m "your message"
```

The name and email must match the commit author. By signing off you certify the
statements in the [DCO](DCO): in short, that you wrote the contribution or
otherwise have the right to submit it under this project's licence.

CI checks this on every pull request. If you forget:

```bash
git commit --amend -s              # the most recent commit
git rebase --signoff origin/main   # a whole branch
git push --force-with-lease
```

## Getting set up

Node.js and npm are the only requirements.

```bash
npm ci
npm run build     # outputs to dist/
npm test          # no network access needed
```

To see it running:

```bash
python3 -m http.server 8080 -d dist
```

## Before opening a pull request

```bash
npm test && npm run build
```

Both must pass. CI runs the same two commands, then feeds every generated
`-march` string to clang, so a string no compiler accepts fails the build.

## How the data fits together

Three sources, each with different authority. It is worth knowing which one you
are changing:

| file | holds | regenerate with |
|---|---|---|
| `src/riscv_extensions.json` | the extension catalogue and instruction encodings | `npm run sync` (riscv-opcodes), `npm run sync:udb` (metadata) |
| `src/isa-dependency-graph.json` | dependencies, conflicts and parameters, with a citation on every edge | `node scripts/seed-dependency-graph.mjs --udb <path>` |
| `src/profiles.js` | the ratified profiles | by hand, from the specification |

`riscv-unified-db` is the normative source for dependencies. clang is the check
that our output is usable in practice. `riscv-config`, RISC-V International's own
validator, disagrees with clang in places; where it does, both opinions are
recorded rather than one being silently preferred.

Two drift checks are available and are worth running if you touched the data:

```bash
npm run graph:check -- <path-to-udb>   # graph vs riscv-unified-db
npm run links:check                    # documentation links vs docs.riscv.org
```

## Invariants the tests enforce

Each of these exists because it was once broken:

- **Every catalogue extension has a graph node.** Adding an extension without
  one fails `tests/isa-graph.test.mjs`. Run the seeder and commit the result.
- **Every graph edge carries a citation.** An uncited edge cannot be audited.
- **No component is declared inside another component.** A component defined in
  a render body is a new type on every render, which remounts its whole subtree.
  This once made selections take seconds.
- **The app renders.** `tests/render-smoke.test.mjs` mounts the built bundle and
  fails on a blank page. A change once shipped an empty grid with every other
  test green.
- **Generated `-march` strings compile**, checked against clang in CI.

## If you are changing the interface

- Light and dark themes both have to work. Contrast is measured rather than
  eyeballed: text pairings sit above the WCAG AA floor of 4.5:1, and new colours
  should clear it too.
- Verify in a browser, not only in the test suite. Nothing renders in the unit
  tests except the smoke test, and that one is deliberately shallow.

## Pull requests

- Keep them focused. One concern per PR reviews far faster than five.
- Say what you verified and how. "Tested in both themes at 1280px" is worth more
  than "works".
- If you found something surprising along the way, put it in the description.
  Several of the sharpest bugs here were found while fixing something else.

## Releasing

Releases are cut by hand. There is no release bot, and the version lives in one
place: `package.json` (with `package-lock.json` following it).

### Choosing the number

The catalogue in `src/riscv_extensions.json` is the product, so **a release that
changes what the catalogue contains is a minor bump even when no code changed**.
An entry that disappears takes any saved selection or `-march` string that
referenced it with it, and a reader should not have to open the diff to discover
that. Reserve a patch for fixes that leave the entry set intact.

### Steps

```bash
git checkout -b chore/release-X.Y.Z
npm version --no-git-tag-version X.Y.Z      # package.json + package-lock.json
```

Add the release section to `CHANGELOG.md`. CI will reject the pull request if the
version moved and no `## [X.Y.Z]` heading appeared, so this is not optional. The
Changelog workflow also prints which catalogue entry ids were added or removed
against the base — take that list, do not retype it from memory. It was written
because hand-counting produced two wrong numbers in a row.

Then verify, open the pull request, and merge it once CI is green:

```bash
npm run lint && npm run build && npm test
```

After the release commit is on `main`:

```bash
git checkout main && git pull
git tag -a vX.Y.Z <sha> -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file <notes>
```

Use the changelog section as the release notes, so the tag and the file cannot
disagree.

### What a release entry carries

- The catalogue size, as `before -> after`, whenever it moved
- Every entry id added or removed, named individually. A rename is stated as a
  rename, with both ids, so nobody reads it as an extension disappearing
- Any change to exported output, since that breaks consumers silently
- The pull request number against each line

## Reporting problems

Open an issue with what you did, what you expected, and what happened. For
anything data-related, a wrong dependency, a missing instruction, a bad
encoding, cite the specification section or the UDB file. That turns a guess
into a fix.

For security reports, see [SECURITY.md](SECURITY.md). Participation is governed
by our [Code of Conduct](CODE_OF_CONDUCT.md).
