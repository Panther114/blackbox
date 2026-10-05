---
name: Blackbox
description: A compact, dark, native-glass workspace for local course materials
colors:
  canvas: "#101217"
  ink: "#eef0f6"
  ink-soft: "#b7bdce"
  ink-muted: "#858ca1"
  primary: "#5b8cff"
  success: "#62d18c"
  warning: "#f1b65e"
  error: "#ff8186"
typography:
  body:
    fontFamily: "Satoshi, Segoe UI Variable Text, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "8px"
  surface: "14px"
---

# Blackbox desktop design

## Overview

An operational workspace. Density is a feature: the file and course lists get nearly the whole window, and chrome (title bar, steps, options) stays thin.

## Material and color

- Windows 11 22H2+ draws a native **Mica** material behind a transparent page; earlier builds get a flat dark ground (`html[data-material]` is set from the main process).
- Surfaces are 3.5–6% white over the material with a 1px hairline and a top highlight. No `backdrop-filter`, no photographic background: the OS does the glass, so it costs nothing at render time.
- Cobalt (`#5b8cff`) is the single action color; green, amber and red appear only with labels and icons.

## Typography

Satoshi (variable, bundled with its ITF FFL license) for everything; headings are 600 weight with tight tracking. No serif display face, no runtime font requests.

## Layout

- A 44px title bar holds the brand, a four-tab navigation and the status pills; native caption buttons overlay the right edge (`titleBarOverlay`). There is no left sidebar.
- The page title is screen-reader only (the active tab already names the view).
- Selection screens: one-line header (title, hint, counts), one options row (course text and download layout), one toolbar row, the table, and a 46px action bar. About ten file rows fit at the 980×680 minimum window.
- Content is capped at 1480px and scrolls inside its surface.

## Components

Segmented controls and the nav indicator are transform-driven. Buttons share 140ms hover/press feedback; progress fills use transforms. Icons are locally vendored Lucide SVGs (1.75px strokes) with the bundled license. Reduced motion removes nonessential movement.

## Do's and Don'ts

Preserve product copy, handlers, workflow state, the `window.blackboxGui` bridge and `data-testid` selectors. Validate 980×680, 1120×760 and 1440×900 with a hidden-window capture (`--capture`, see README); never take desktop screenshots. Keep everything local: fonts, icons and imagery are packaged, nothing is requested at runtime.
