# Pocket guide fonts

IBM Plex, embedded in every edition of the printable pocket guide by
`scripts/pocket-guide.mjs`, so the PDF is set the same on any machine.
Licensed under the SIL Open Font License 1.1 (`OFL.txt`, from
[IBM/plex](https://github.com/IBM/plex/blob/master/LICENSE.txt)).

Latin subset, woff2, from the Fontsource packages, version **5.3.0**:

| File | Source |
|---|---|
| `ibm-plex-sans-latin-400-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-400-normal.woff2 |
| `ibm-plex-sans-latin-400-italic.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-400-italic.woff2 |
| `ibm-plex-sans-latin-600-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-600-normal.woff2 |
| `ibm-plex-sans-latin-700-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-700-normal.woff2 |
| `ibm-plex-sans-condensed-latin-700-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans-condensed@5.3.0/files/ibm-plex-sans-condensed-latin-700-normal.woff2 |
| `ibm-plex-mono-latin-400-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-400-normal.woff2 |
| `ibm-plex-mono-latin-700-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-700-normal.woff2 |

These are the faces the guide's CSS uses. A new weight or style there needs
its file here and an entry in `FONTS` in `scripts/pocket-guide.mjs`; the
build fails if a listed file is missing.
