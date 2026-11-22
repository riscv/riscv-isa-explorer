# UDB export check

Runs riscv-unified-db's own config validator on the builder's UDB export
(#589). CI does this in `.github/workflows/udb-validate.yml`. This page is for
running it locally, which is also the way to check a configuration you cannot
paste into a public workflow run.

| File | Does |
|---|---|
| `generate.mjs` | Writes the configurations: every profile, and each extension alone on RV64I and RV32I, or one `--selection` / `--cfg` |
| `fill.mjs` | Fills the export's TODO parameters with schema-valid values, and adds gated parameters the values bring into scope |
| `validate.rb` | Loads UDB once and runs `ConfiguredArchitecture#valid?` (what `udb validate cfg` runs) on every file |
| `classify.mjs` | Sorts UDB's reasons into structural (the export's fault) and value (the filled values') |
| `report.mjs` | Compares with `baseline.json` and writes the summary |
| `baseline.json` | Structural failures accepted for now, each with the reason it is accepted |

## Locally

```sh
# riscv-unified-db at the commit our data is pinned to
pin=$(node -p "require('./src/isa-dependency-graph.json').sources.udb.commit")
git -C ../riscv-unified-db worktree add --detach ../udb-pinned "$pin"

docker build -t udb-validate scripts/udb-validate
docker volume create udb-bundle; docker volume create udb-cache
run() { docker run --rm -e XDG_CACHE_HOME=/cache -v udb-cache:/cache \
  -v udb-bundle:/usr/local/bundle -v "$PWD/../udb-pinned:/udb" -v "$PWD:/work" \
  udb-validate bash -c "$1"; }
run 'bundle install'
run 'cd /tmp && bundle exec --gemfile /udb/Gemfile ruby /udb/tools/ruby-gems/udb/ext/udb_download/extconf.rb'

node scripts/udb-validate/generate.mjs --out out/udb      # or --selection RV64I,M,A,C
run 'bundle exec ruby /work/scripts/udb-validate/validate.rb /work/out/results.json /work/out/udb/*.yaml'
node scripts/udb-validate/report.mjs out/results.json --baseline scripts/udb-validate/baseline.json
```

To check a file of your own as it is: `run 'bundle exec udb validate cfg /work/my-config.yaml'`.

Each configuration takes a few seconds once UDB is loaded. `validate.rb` drops
each configured architecture after checking it; keeping them all filled a 4 GB
Docker VM and slowed the run to minutes per file.
