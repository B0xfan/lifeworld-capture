#!/bin/sh
# Builds docs/LifeWorld-Capture-manual.pdf from docs/manual.md and its pictures. Needs pandoc and typst. No browser.
set -eu
cd "$(dirname "$0")/../docs"
nice -n 19 pandoc -f gfm -t typst --pdf-engine=typst --shift-heading-level-by=-1 --metadata subtitle="User manual" \
  -V papersize=us-letter -V margin.x=2cm -V margin.y=2cm -V mainfont="Helvetica Neue" -V fontsize=10.5pt \
  -V include-before='#set par(justify: false)
#show table.cell: set align(left)
#show link: set text(fill: rgb("#1a5fb4"))' \
  -o LifeWorld-Capture-manual.pdf manual.md
echo "docs/LifeWorld-Capture-manual.pdf written"
