---
name: Intar Web
description: A calm, precise app system for technical learning and repair work.
colors:
  canvas: "var(--canvas)"
  background: "var(--background)"
  foreground: "var(--foreground)"
  faint-foreground: "var(--faint-foreground)"
  card: "var(--card)"
  card-foreground: "var(--card-foreground)"
  primary: "var(--primary)"
  primary-hover: "var(--primary-hover)"
  primary-foreground: "var(--primary-foreground)"
  brand-subtle: "var(--brand-subtle)"
  brand-text: "var(--brand-text)"
  brand-border: "var(--brand-border)"
  secondary: "var(--secondary)"
  secondary-foreground: "var(--secondary-foreground)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  border: "var(--border)"
  border-strong: "var(--border-strong)"
  input: "var(--input)"
  ring: "var(--ring)"
  success: "var(--success)"
  warning: "var(--warning)"
  info: "var(--info)"
  destructive: "var(--destructive)"
  sidebar: "var(--sidebar)"
  sidebar-foreground: "var(--sidebar-foreground)"
  sidebar-accent: "var(--sidebar-accent)"
  sidebar-accent-foreground: "var(--sidebar-accent-foreground)"
  terminal-background: "var(--terminal-background)"
  terminal-foreground: "var(--terminal-foreground)"
typography:
  display:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "clamp(2.5rem, 4.6vw, 4rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  feature-title:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  page-title:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  card-title:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.008em"
  body:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "\"Geist Mono Variable\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
  button:
    fontFamily: "\"Geist Variable\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
rounded:
  xs: "0.25rem"
  sm: "0.3125rem"
  md: "0.375rem"
  lg: "0.5rem"
  xl: "0.75rem"
  2xl: "1rem"
  3xl: "1.25rem"
  4xl: "1.5rem"
spacing:
  2xs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "1.5rem"
  2xl: "2rem"
  3xl: "3rem"
  4xl: "4rem"
  5xl: "6rem"
  control-utility: "1.75rem"
  control-compact: "2rem"
  control-standard: "2.25rem"
  control-prominent: "2.75rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0 0.875rem"
    height: "{spacing.control-standard}"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0 0.875rem"
    height: "{spacing.control-standard}"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 0.75rem"
    height: "{spacing.control-standard}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  sidebar-nav-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xs}"
    height: "2.125rem"
---

# Design System: Intar Web

## Overview

**Creative North Star: "The Calm Control Room"**

Intar is a quiet instrument for learning and repair. Two neutral grounds, Graphite (dark) and Paper (light), carry almost everything. One oxide accent marks the next useful action, and one shared motion language explains every change of state. The app lives in a floating panel beside the navigation, so work always reads as one surface.

Nothing is decorated for its own sake. Hierarchy comes from size, weight, and tracking in a single type family. Depth comes from tone first, then a hairline, then a faint top light. Motion appears only when something changes.

**Key Characteristics:**

- Cool graphite and soft paper neutrals that share one ink.
- One oxide accent for the main action, focus, and the live state.
- Geist for every role; Geist Mono only for commands, IDs, logs, and timers.
- An inset app panel with a sticky bar that carries its top edge.
- Quiet borders, raised surfaces with a top light, and no glow or glass.
- Motion that confirms, reveals, or reports live state, and nothing else.

## Colors

Neutrals carry structure, oxide carries action, and four semantic hues carry state. Every text pairing meets 4.5:1 on its surfaces in both themes.

### Neutral

- **Canvas:** the sidebar, the frame around the app panel, the public landing, and the run workspace.
- **Background:** the app panel itself and long-form reading.
- **Card:** raised surfaces inside the panel: lists, fields, meters, and action gates.
- **Muted and accent:** hover and pressed fills. Accent is one step stronger than muted.
- **Foreground tiers:** foreground for primary text, muted-foreground for supporting text, faint-foreground for captions, labels, and metadata.
- **Lines:** border for cards and dividers, input for control edges, border-strong for hover.
- **Terminal:** always dark in both themes. Terminal colors are only for terminal, code, and replay content.

### Primary

- **Oxide action:** primary and primary-foreground for the one main action, the focus ring, and the live-state dot. Hover uses primary-hover.
- **Oxide support:** brand-subtle, brand-text, and brand-border for icon tiles, links, and the current item in a sequence.

### Status

- **Success:** verified checks, available capacity, a solved run.
- **Warning:** a check that needs repair, a becoming state. It is an open task, not an error.
- **Info:** a check that is checking right now.
- **Destructive:** failures and destructive actions.

### Named Rules

**The Oxide Signal Rule.** Use the oxide colors for one main action, the current selection, or the live state in a local area. Keep the surrounding surface neutral.

**The Status Word Rule.** Pair every status color with a word or an icon. Color never carries state alone.

**The Always-Dark Terminal Rule.** Terminal surfaces use the terminal palette in both themes, so commands look the same everywhere.

## Typography

**Family:** Geist Variable for display, titles, interface, and reading. Geist Mono Variable for commands, code, IDs, logs, and running timers.

**Character:** Geist is precise without being cold, and its mono shares the same skeleton, so terminal content and interface copy sit together without a seam.

### Hierarchy

- **Display:** rare public statements. Two-tone: the claim in foreground, the payoff in faint-foreground.
- **Feature title:** the main title of a recap or feature block.
- **Page title:** content headers and course titles.
- **Section title:** short structural headings.
- **Card title:** list rows, panels, and dense headings.
- **Body:** instructions and Markdown reading at 1.7 line height, capped at 68ch.
- **Label:** sentence-case group labels and small headings in faint-foreground. No uppercase tracking.
- **Mono:** commands, code blocks, IDs, and timers only.

### Named Rules

**The Data Line Rule.** Put static facts in one small tabular sans line with middle-dot separators. Use chips only when the user can operate them.

**The Mono Is Material Rule.** Mono marks things a learner types or reads from a machine. Ordinary metadata never uses it.

## Layout

The app frame is a 16rem sidebar on the canvas and an inset panel with an 8px margin and 12px corners on desktop. The collapsed sidebar is 3rem. On mobile the sidebar is an 18rem sheet and the panel is full-bleed.

The app bar is 3.25rem high and sticky. On desktop it also draws the panel's top corners and side borders above an 8px canvas band, so the panel stays whole while the page scrolls underneath.

Authenticated page shells fill the available app viewport through 2048px. Page inset grows from 1rem to 1.5rem at 40rem and to 2rem at 64rem. Page content must not add a maximum width that leaves unused app space.

Lecture pages use one fluid column below 1100px and a three-to-one content and course-outline grid from 1100px. The mobile app bar opens the same course outline in a bottom sheet. Live run workspaces put the terminal and the learning panel on the canvas as two rounded cards, two-to-one from 960px. The learning panel's checks stay pinned above long theory and hints.

### Named Rules

**The One Frame Rule.** Keep app navigation in the sidebar and page identity in the app bar. Do not make a second page header compete with the app bar heading.

**The Fluid Content Rule.** Let page content use the available app viewport. Put a lecture action after the reading unit and use the course outline for lecture navigation.

**The Full-Screen Work Rule.** A lecture action opens the focused run shell before it sends the start request. Startup, live work, and shutdown use the same workspace grid and keep the checks and learning panel available. The normal sidebar and app bar return only when the settled recap or replay is ready.

## Elevation & Depth

Depth comes from tone first. Cards sit one step above the panel, the panel one step above the canvas.

### Shadow Vocabulary

- **Highlight:** a 1px top light inside raised surfaces in dark mode (`--highlight`).
- **Raised:** a hairline shadow for cards and the app panel (`--shadow-raised`).
- **Control:** a 1px drop under fields and outline buttons (`--shadow-control`).
- **Overlay:** a soft, deep shadow for dialogs, menus, sheets, and tooltips (`--shadow-overlay`).

### Named Rules

**The Quiet Depth Rule.** Use a tone step or a hairline first. Never use glow, glass, blur, or colored shadows.

## Shapes

Controls use 8px corners, list rows 10px, cards and panels 12px, dialogs and hero cards 16px. Round shapes are reserved for status dots, avatars, and progress segments.

Borders are thin and quiet. Long lists keep one outer border and use dividers between rows.

## Motion

Motion explains a change of state, or it does not happen.

- **Standard (160ms, `ease-standard`):** hover, color, border, and focus changes.
- **Enter (320–550ms, `ease-enter`):** reveals, dialogs and sheets opening, meters filling, sections rising in on arrival.
- **Confirm (420ms, `ease-confirm`):** a small overshoot used only when a check turns verified and for the solved badge.
- **Live (2.2s loop):** one expanding ring on the single live or becoming status in a view.
- **Press:** a half-pixel drop and a 1.5% shrink on every button.
- **Nudge:** arrows lean 2px toward their destination on hover.

Reduced motion drops every duration to 0.01ms and stops loops. Any animated illustration shows a meaningful still frame instead.

### Named Rules

**The One Pulse Rule.** At most one element breathes in a view, and it is the live state. Lists stay still.

**The Moment Rule.** Celebrate a transition when it happens, not on every page load. A check that was already verified does not pop again.

## Components

### Buttons

- **Shape:** 8px corners. 36px default, 32px small, 44px prominent and on coarse pointers.
- **Primary:** oxide fill with a faint top light. Hover uses primary-hover.
- **Outline:** card fill, input edge, control shadow. Hover strengthens the edge and fills with muted.
- **Destructive:** quiet outline with destructive text; hover fills destructive-subtle. **Danger** is the solid variant, reserved for the final confirm inside a dialog.
- **Focus:** a 2px ring outline with a 2px offset on every control.

### Fields

- **Style:** card fill, input edge, control shadow, standard height.
- **Focus:** the edge turns to the ring color with a soft 3px ring.
- **Placeholder:** faint-foreground.

### Cards / Containers

- **Corner Style:** 12px.
- **Background:** card on the panel, with the highlight and raised shadow.
- **Border:** one quiet border, with dividers for rows.
- **Interactive:** hover strengthens the edge and shifts the fill 3% toward the foreground.

### Navigation

- **Style:** canvas sidebar with 34px rows and 8px corners.
- **State:** hover fills sidebar-accent. The active row is raised to card with a hairline and its icon turns oxide.
- **Live count:** the runs badge carries a live dot while a run is ongoing.

### Tabs

One indicator glides between tabs. The line variant draws a 2px oxide underline; the default variant slides a raised pill.

### Status Token

A small dot, a direct word, and an optional mono clock. The one live status in a view uses the live ring. List status stays quiet.

### Checks

Needs repair is a dashed amber ring, checking is a blue spinner, and verified is a green check. A check that turns verified flashes its row once and pops its icon. A segmented bar under the heading shows every check at a glance.

### Code Blocks

Markdown code blocks use the always-dark terminal surface with a Copy action that confirms in place.

### Reading Action Gate

The next action after a reading unit sits in a card with an oxide icon tile, placed after the Markdown body.

## Do's and Don'ts

### Do:

- **Do** use the semantic color properties so light and dark themes keep the same roles.
- **Do** keep direct status words with dots, icons, and live feedback.
- **Do** let long Markdown use its fluid page or panel column.
- **Do** use the tabular sans data line for static counts, durations, and course facts.
- **Do** use the oxide action color for the one main action in a local area.

### Don't:

- **Don't** use color as the only status signal.
- **Don't** use chip rows for static metadata.
- **Don't** use mono for ordinary interface copy.
- **Don't** add glow, glass, blur, or colored shadows.
- **Don't** animate on page load what did not just change.
- **Don't** add an in-flow h1 that competes with the app bar page title.
