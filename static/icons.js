/* ===========================================================================
   Icon set
   ---------------------------------------------------------------------------
   One place for every icon in the app, so they all look like they belong to the
   same family. All of them follow the samkoBuilds icon rules:
     - drawn on a 24x24 grid
     - 2px stroke, round caps and joins
     - outline only, never filled
   Any element in the HTML written as <span data-icon="send"></span> gets its
   icon filled in by drawIcons() in app.js.
   =========================================================================== */
const ICONS = {
  menu:        "M4 7h16M4 12h16M4 17h16",
  plus:        "M12 5v14M5 12h14",
  close:       "M18 6 6 18M6 6l12 12",
  "chevron-down": "m6 9 6 6 6-6",
  refresh:     "M21 4v6h-6M3 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L21 8M20.5 15a9 9 0 0 1-14.9 3.4L3 16",
  rotate:      "M3 4v6h6M3.5 15a9 9 0 1 0 2.1-9.4L3 10",
  settings:    "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  send:        "M12 19V5M5 12l7-7 7 7",
  stop:        "M7 7h10v10H7z",
  copy:        "M10 9h10v12H10zM6 15H4V3h12v2",
  trash:       "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  message:     "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  image:       "M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M9.5 8.5h.01",
  video:       "m23 7-7 5 7 5zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
  terminal:    "m4 17 6-6-6-6M12 19h8",
  file:        "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  wrench:      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
  user:        "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  upload:      "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  info:        "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 16v-5M12 8h.01",
};

/* Build the SVG markup for one icon. `size` is in pixels. */
function iconSvg(name, size = 20) {
  const d = ICONS[name];
  if (!d) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/* Fill in every <span data-icon="…"> inside `root` (defaults to the whole page). */
function drawIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    el.innerHTML = iconSvg(el.dataset.icon, Number(el.dataset.iconSize) || 20);
  });
}
