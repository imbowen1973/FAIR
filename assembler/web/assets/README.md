# Pane assets

`fair-logo.png` is a copy of `edufair-logo.png`, and exists only for task
panes that cached `taskpane.html` before the rename. The Office webview
keeps files far longer than the `max-age=600` GitHub Pages sends, so a
pane can go on asking for the old name for a long time after the deploy
that changed it — and shows a broken logo when it does.

Delete it once no pane is plausibly still running pre-rename HTML. The
build stamp at the foot of the pane says which commit a pane is on.
