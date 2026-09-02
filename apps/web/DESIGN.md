---
name: Intar Web
description: A warm, direct app system for technical learning and repair work.
colors:
  background: "var(--background)"
  foreground: "var(--foreground)"
  card: "var(--card)"
  card-foreground: "var(--card-foreground)"
  primary: "var(--primary)"
  primary-foreground: "var(--primary-foreground)"
  brand-subtle: "var(--brand-subtle)"
  brand-text: "var(--brand-text)"
  brand-border: "var(--brand-border)"
  secondary: "var(--secondary)"
  secondary-foreground: "var(--secondary-foreground)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  border: "var(--border)"
  input: "var(--input)"
  ring: "var(--ring)"
  success: "var(--success)"
  warning: "var(--warning)"
  destructive: "var(--destructive)"
  sidebar: "var(--sidebar)"
  sidebar-foreground: "var(--sidebar-foreground)"
  sidebar-accent: "var(--sidebar-accent)"
  sidebar-accent-foreground: "var(--sidebar-accent-foreground)"
  terminal-background: "var(--terminal-background)"
  terminal-foreground: "var(--terminal-foreground)"
typography:
  display:
    fontFamily: "\"Recursive Heading\", \"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 7vw, 5.75rem)"
    fontWeight: 760
    lineHeight: 0.98
    letterSpacing: "-0.045em"
    fontVariation: "\"CASL\" 0.2, \"CRSV\" 0.25"
  feature-title:
    fontFamily: "\"Recursive Heading\", \"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.03em"
    fontVariation: "\"MONO\" 0, \"CASL\" 0.1, \"CRSV\" 0"
  page-title:
    fontFamily: "\"Recursive Heading\", \"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.025em"
    fontVariation: "\"MONO\" 0, \"CASL\" 0.1, \"CRSV\" 0"
  section-title:
    fontFamily: "\"Recursive Heading\", \"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.333
    letterSpacing: "-0.01em"
    fontVariation: "\"MONO\" 0, \"CASL\" 0.05"
  card-title:
    fontFamily: "\"Recursive Heading\", \"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.375
    letterSpacing: "-0.01em"
    fontVariation: "\"MONO\" 0, \"CASL\" 0.04"
  body:
    fontFamily: "\"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "\"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0.035em"
  mono:
    fontFamily: "\"Recursive Mono\", SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
  button:
    fontFamily: "\"Atkinson Hyperlegible Next Variable\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
rounded:
  sm: "calc(var(--radius) * 0.55)"
  md: "calc(var(--radius) * 0.75)"
  lg: "var(--radius)"
  xl: "calc(var(--radius) * 1.25)"
  2xl: "calc(var(--radius) * 1.55)"
  3xl: "calc(var(--radius) * 1.9)"
  4xl: "calc(var(--radius) * 2.25)"
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
  control-utility: "2rem"
  control-compact: "2.25rem"
  control-standard: "2.5rem"
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
    backgroundColor: "{colors.background}"
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
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xs}"
    height: "{spacing.control-compact}"
---

# Design System: Intar Web

## Overview

**Creative North Star: "The Warm Technical Workbench"**

Intar is a warm technical workbench for learning and repair. The app uses a calm neutral ground, readable type, and one rust action color. It keeps the user in an app frame and makes work state direct.

The system uses little decoration. A border, a small tonal change, or a small shadow separates work areas. The primary action stays clear. Light and dark themes keep the same role names and action priority.

**Key Characteristics:**

- Warm neutral ground and paper-like content surfaces.
- Rust actions with clear text labels.
- Dense but readable app frame and metadata.
- Quiet borders and small, functional depth.
- Fluid page columns for Markdown content.

## Colors

The palette uses warm neutrals for structure, rust for action, and semantic colors for state.

### Primary

- **Rust action:** Use primary and primary foreground for the main action, focus ring, and active work state.
- **Rust support:** Use brand subtle, brand text, and brand border for selected rows and restrained action panels.

### Secondary

- **Warm secondary:** Use secondary for numbered units and low-priority emphasis.

### Neutral

- **Warm ground:** Use background as the app canvas.
- **Paper surface:** Use card for lists, fields, and contained content.
- **Quiet structure:** Use muted and border for supporting text and separation.
- **Terminal surface:** Use the terminal colors only for terminal and replay content.

### Named Rules

**The Rust Signal Rule.** Use the rust colors for one main action, active selection, or working state in a local area. Keep the surrounding surface neutral.

**The Status Text Rule.** Use success, warning, and destructive colors with a direct word or icon. Color never carries state alone.

## Typography

**Display Font:** Recursive Heading with Atkinson Hyperlegible Next Variable and system sans fallbacks.

**Body Font:** Atkinson Hyperlegible Next Variable with system sans fallbacks.

**Label/Mono Font:** Recursive Mono with platform monospace fallbacks.

**Character:** The heading face gives technical titles a compact, human shape. The body face keeps long instructions clear. The mono face marks facts, times, and system data.

### Hierarchy

- **Display:** Use for rare large landing statements.
- **Feature title:** Use for the main title in a recap or a feature block.
- **Page title:** Use for content headers and course titles.
- **Section title:** Use for short structural headings.
- **Card title:** Use for list rows and compact panels.
- **Body:** Use for instructions and Markdown reading.
- **Label:** Use for compact panel labels and secondary system headings.
- **Mono:** Use for metadata, timestamps, counts, code, and terminal content.

### Named Rules

**The Data Line Rule.** Put static facts in one small mono line with middle-dot separators. Use chips only when the user can operate them.

## Layout

The normal app frame has a 16rem sidebar on desktop and a 3rem compact sidebar. The mobile sidebar is a sheet that is 18rem wide. The app bar is 3rem high and keeps the page title visible.

Authenticated page shells fill the available app viewport through 2048px. Page inset grows from 1rem to 1.5rem at 40rem and to 2rem at 64rem. Page content must not add a maximum width that leaves unused app space.

Lecture pages use one fluid column below 1100px and a three-to-one content and course-outline grid from 1100px. The mobile app bar opens the same course outline in a bottom sheet. Live run workspaces use a two-to-one terminal and learning grid from 960px. Checks stay pinned above long theory and hints.

### Named Rules

**The One Frame Rule.** Keep app navigation in the sidebar and page identity in the app bar. Do not make a second page header compete with the app bar heading.

**The Fluid Content Rule.** Let page content use the available app viewport. Put a lecture action after the reading unit and use the course outline for lecture navigation.

**The Full-Screen Work Rule.** Only a foreground run hides the normal app frame. Saving, recap, and replay use the normal sidebar and app bar.

## Elevation & Depth

The system is flat by default. Borders and warm tonal changes make most separation. Standard cards use a very small shadow, and interactive cards increase it only on hover.

### Shadow Vocabulary

- **Card rest:** 0 1px 2px 0 rgb(0 0 0 / 0.05).
- **Interactive card hover:** 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1).

### Named Rules

**The Quiet Depth Rule.** Use a border or tonal difference first. Use the small shadow only to show a contained or interactive surface.

## Shapes

The base corner size is 0.625rem. Back links and small labels use the medium curve. Buttons, fields, and sidebar rows use the large curve. Cards and grouped lists use the extra-large curve.

Borders are thin and quiet. Long lists keep one outer border and use dividers between rows. Do not use strong outlines for ordinary content.

## Components

### Buttons

- **Shape:** Large curve with a standard 2.5rem control height.
- **Primary:** Primary background, primary foreground, and 0.875rem horizontal padding. Hover uses brand text. Active state moves down by 1px.
- **Outline:** Background fill with a quiet border. Hover uses muted fill.
- **Focus:** Use the ring color with a visible 3px ring. Keep the reduced-motion override active.

### Chips

- **Style:** Small labels use the medium curve, a compact height, and semantic background or border colors.
- **State:** Use chips for filters and other controls. Use the mono metadata line for static facts.

### Cards / Containers

- **Corner Style:** Extra-large curve on card and grouped-list surfaces.
- **Background:** Card on the warm ground.
- **Shadow Strategy:** Use the quiet card shadow from Elevation & Depth.
- **Border:** One quiet border around the surface, with dividers for rows.
- **Internal Padding:** Use the large spacing step by default and the medium step for compact cards.

### Inputs / Fields

- **Style:** Card fill, input border, large curve, and standard control height.
- **Focus:** Change to the ring color and add a visible 3px ring.
- **Disabled:** Use muted fill and lower opacity. Keep the control text readable.

### Navigation

- **Style:** Warm sidebar surface with 2.25rem navigation rows, 0.5rem padding, and 0.625rem corners.
- **State:** Hover and active rows use sidebar accent. Active rows also use semibold text.
- **Mobile:** Use the same navigation as an 18rem sheet. Keep desktop navigation in the fixed sidebar.

### Status Token

The status token is a small colored dot, a direct state word, and an optional mono duration. It can pulse only for an amber becoming state. List status stays quiet; only the one live status in a view announces changes.

### Reading Action Gate

Use a brand-subtle panel with top and bottom brand borders when a reading unit has one next action. Keep the action panel compact and place it after the Markdown body.

## Do's and Don'ts

### Do:

- **Do** use the semantic color properties so light and dark themes keep the same roles.
- **Do** keep direct status words with dots, icons, and live feedback.
- **Do** let long Markdown use its fluid page or panel column.
- **Do** use the mono metadata line for static counts, durations, and course facts.
- **Do** use the rust action color for the one main action in a local area.

### Don't:

- **Don't** use color as the only status signal.
- **Don't** use chip rows for static metadata.
- **Don't** add a large shadow when a quiet border or tonal change gives enough separation.
- **Don't** add an in-flow h1 that competes with the app bar page title.
