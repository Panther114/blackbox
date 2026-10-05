---
name: Blackbox
description: A centered glass workspace for local course materials
colors:
  canvas: "#dce9f2"
  ink: "#152c44"
  ink-soft: "#344e67"
  primary: "#235ce0"
  primary-deep: "#174bbf"
  success: "#316738"
  warning: "#80531d"
  error: "#a23e40"
typography:
  display:
    fontFamily: "Gambetta, Georgia, serif"
    fontSize: "clamp(38px, 4.4vw, 53px)"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-0.028em"
  body:
    fontFamily: "Satoshi, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "7px"
  surface: "16px"
---

# Blackbox desktop design

## Overview

The desktop is an operational workspace: course discovery, file selection, saving, automation and local setup retain their current semantics and copy.

## Colors

Pale blue photographic ground, navy text, cobalt actions and labeled green, amber and red outcomes.

## Typography

Satoshi controls and tables pair with Gambetta headings. Fonts are locally embedded, unmodified, and distributed with their official ITF FFL licenses.

## Layout

- Centered brand and four-view navigation above one broad working surface; no left sidebar, including in Settings.
- A bundled pale alpine lake photograph stays stationary behind frosted glass. Surface gradients use white at 62% opacity to cool white at 40%, with static 22px blur, fine light edges and an offset soft shadow.
- Navy text (`#152c44`), secondary blue-gray (`#344e67`), cobalt actions (`#235ce0`); green, amber and red communicate outcomes with labels and icons.
- Satoshi variable font for controls, tables and body copy; Gambetta variable font for headings. Both are unmodified Fontshare fonts, embedded locally with their ITF FFL licenses. The user explicitly replaced the former Bai Jamjuree direction.
- A 1200px maximum workspace, 16px surface corners, 7px controls, and thin consistent SVG icons. Dense tables scroll inside their surface; long settings screens scroll in the main workspace.

## Elevation & Depth

The photographic background shows through one frosted plane. A static 22px backdrop blur, pale edge highlights and an offset soft shadow define depth. No nested glass cards.

## Shapes

16px surface corners, 7px controls and consistent 1.5px icon strokes. Fine lines separate data rows and related groups.

## Components

Navigation uses four equal tracks and a transform-driven underline, independent of font measurements. Glass planes remain stationary; their contents enter in 220ms without remounting workflow state or replaying on hidden workflow changes. All button families share 160ms hover/press feedback. Progress fills use transforms. Dialogs use a bounded veil and short depth transition. Reduced motion removes nonessential movement. Interface icons use locally vendored Lucide SVG geometry (1.75px strokes), with pinned source revision and bundled ISC/MIT attribution.

## Do's and Don'ts

Preserve all product copy, handlers, workflow state, bridge contracts and existing test selectors. Validate 980×680, 1200×820 and 1440×900, plus the actual minimum native window. Background imagery, fonts and licenses must be packaged locally. Rebuild through the canonical pipeline; never hand-edit an archive to replace one missing dependency.

### Reference and implementation

Generated ready, course and settings references live under `.impeccable/mocks/`. The user approved implementation, then requested denser controls, more glass and a premium unique font; those instructions supersede the reference image's density and typography. Final appearance is defined by the rendered application and renderer tokens.
