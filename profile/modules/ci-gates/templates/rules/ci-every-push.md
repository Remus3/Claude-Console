- CI ON EVERY PUSH. The main workflow has no paths-ignore: a docs-only push runs the whole
  workflow, because some tests read docs and a skipped run proves nothing.
