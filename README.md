# Oasis-spaces — website

The public site for Oasis-spaces: *Film your room once. Redesign it in 3D.*

Plain HTML, CSS and JavaScript, no build step. The three 3D previews (the
room assembling from scan points, the drag-and-drop editor, the before/after
redesign) are built from primitives in metres with Three.js, loaded from
jsdelivr — there are no model files.

## Run locally

    python3 -m http.server 8735

then open http://localhost:8735.

## Deploy

Hosted on Render as a free static site from `render.yaml` (publish path `.`,
nothing to build). Every push to `main` deploys.

## Suggestion box

The form at the bottom opens the visitor's mail app addressed to
contact@oasis-spaces.info. To collect suggestions without a mail app, set
`SUGGEST_ENDPOINT` in `main.js` to a form service that forwards to that address.
