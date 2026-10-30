# assets/

The samkoBuilds logo files. The app looks for them by these exact names, in this order:

| File | What it is | Status |
|---|---|---|
| `samkobuilds-monogram.svg` | the "sB" monogram, as scalable vector art | not here yet — add it when you have it, and the app will prefer it automatically |
| `samkobuilds-monogram.png` | the "sB" monogram as a picture | **in use** — the watermark at the bottom of the sidebar, and the browser-tab icon |
| `samkobuilds-lockup.svg` | monogram + "samkoBuilds" wordmark | not used yet. The brand rules only allow the full lockup at 32px height or more, which no placement in the app currently reaches. |

## What was done to the PNG

The monogram you supplied was 870x897 with the mark floating in the middle of a flat
dark square. Two things were changed, neither of which touches the mark itself:

1. **Cropped** to the mark plus a small even margin (the clear space around it is added by the
   app's CSS, so it does not need to be baked into the file).
2. **The flat dark backdrop was made transparent**, so the mark sits cleanly on any charcoal
   surface instead of showing a dark square that is slightly off from the sidebar colour.

The letter colours were copied through untouched, and the shape was never stretched or rotated.
Your original file is unchanged — if you want the backdrop back, just drop the original in here
under the same name.

## Why an SVG would still be better

A PNG is a fixed grid of pixels, so it gets slightly soft on a high-resolution screen and when the
browser shrinks it to a 16px tab icon. An SVG is drawn from shapes, so it stays sharp at every
size. If you ever export one from the original design file, put it here as
`samkobuilds-monogram.svg` and the app will switch to it on the next page load — no code change.

## How the app treats these files

It only ever scales them **by height**, so they can never be stretched or squashed. It never
recolours, rotates, or adds a shadow, glow or outline. The watermark sits at 60% opacity and
rises to 100% on hover, which the brand guidelines allow as a muted presence.
