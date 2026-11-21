[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/yannyonn94/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/yannyonn94/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# Fast CSV reader

A faster drop-in for make.fun's own csv-reader 1.0.0, for the
[`csv-reader-speed-01-run-20261121`](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty. `solve.js` exports `run(input)` returning exactly what csv-reader
1.0.0 returns for `{text, header}` — `{columns, rows, errors}` — including
its broken-row policy: BOM drop, LF/CRLF record ends, lone CRs dropped
(`stray_cr`), quoted fields with `""` escapes and CR/CRLF read as LF,
junk after a closing quote (`quote_junk`), unterminated quotes re-read
as unquoted (`unterminated_quote`), and ragged rows padded or cut
(`short_row` / `long_row`).

Speed comes from the reference's per-character concatenation being replaced
with native `indexOf` delimiter scans and `slice` field extraction, so a
common unquoted field costs one scan and one slice; quoted fields are
found with `indexOf('"')` and only transformed when they actually contain
a newline, a CR, or a doubled quote. No dependencies, no network, no
WebAssembly — plain JavaScript/TypeScript source only.

## Run

```bash
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node runs TypeScript directly (type stripping), so no build step is needed.
