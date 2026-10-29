# Staff guide ("How TDOT works")

Served at `/admin/guide` (the 📘 Guide button in the staff header). The page in `guide.html` holds no guide content;
it fetches `/admin/guide/data` (`guide-data.json`), which answers only to the team key or a Monday staff sign-in.

Both files are generated — do not edit them by hand. They are built from the app's own code by the staff-guide
pipeline (local branch `staff-guide`, folder `docs/staff-guide`): edit the content there, run
`node build.js --server <this folder>`, and commit the two regenerated files.
