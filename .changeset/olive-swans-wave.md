---
"@itsacoyote/katra": patch
---

Titles and columns are measured in characters, not UTF-16 code units.

`list` and `log` sized their columns with `String.length` and padded with `padEnd`, both of which count a single emoji as two. A title containing non-BMP characters therefore measured twice its visible width and pushed every other row's columns out of line. Clamping a title could also cut between the halves of a surrogate pair and emit a broken character, and a title of exactly the column width lost its last character to an ellipsis it did not need.
