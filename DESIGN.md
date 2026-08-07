---
name: Synaptic Precision
colors:
  surface: '#121414'
  surface-dim: '#121414'
  surface-bright: '#38393a'
  surface-container-lowest: '#0c0f0f'
  surface-container-low: '#1a1c1c'
  surface-container: '#1e2020'
  surface-container-high: '#282a2b'
  surface-container-highest: '#333535'
  on-surface: '#e2e2e2'
  on-surface-variant: '#dfc0b2'
  inverse-surface: '#e2e2e2'
  inverse-on-surface: '#2f3131'
  outline: '#a68b7e'
  outline-variant: '#574237'
  surface-tint: '#ffb68e'
  primary: '#ffb68e'
  on-primary: '#542200'
  primary-container: '#f77a25'
  on-primary-container: '#5a2500'
  inverse-primary: '#9c4500'
  secondary: '#bac6ea'
  on-secondary: '#24304c'
  secondary-container: '#3a4664'
  on-secondary-container: '#a9b5d8'
  tertiary: '#bfc7d3'
  on-tertiary: '#29313a'
  tertiary-container: '#969ea9'
  on-tertiary-container: '#2d353e'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdbca'
  primary-fixed-dim: '#ffb68e'
  on-primary-fixed: '#331200'
  on-primary-fixed-variant: '#773300'
  secondary-fixed: '#d9e2ff'
  secondary-fixed-dim: '#bac6ea'
  on-secondary-fixed: '#0e1b36'
  on-secondary-fixed-variant: '#3a4664'
  tertiary-fixed: '#dbe3ef'
  tertiary-fixed-dim: '#bfc7d3'
  on-tertiary-fixed: '#141c25'
  on-tertiary-fixed-variant: '#3f4851'
  background: '#121414'
  on-background: '#e2e2e2'
  surface-variant: '#333535'
  background-deep: '#303841'
  memory-stated: '#F77A25'
  memory-inferred: '#C2CEF2'
  surface-light: '#FAFAFA'
  warning-pii: '#F77A25'
typography:
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
  container-max-width: 1200px
---

## Brand & Style
The design system embodies a **Synaptic & Precise** aesthetic, balancing the high-tech nature of artificial intelligence with the warmth and clarity of human-centric controls. The brand personality is transparent, authoritative yet humble, and deeply protective of user autonomy.

The visual style is a blend of **Corporate Modern** and **Tactile Minimalism**. It utilizes a dark, sophisticated backdrop to represent the "void" of machine processing, while using sharp, vibrant accents to bring "negotiated" facts into focus. The interface must feel like a high-end technical instrument—precise, responsive, and trustworthy—avoiding overly decorative elements in favor of functional data visualization and clear state indicators.

## Colors
The palette is functional and semantic, prioritizing the distinction between different origins of data.

- **Primary (Vibrant Orange):** Reserved for "Stated" memory—facts explicitly provided by the user. It is also used for primary calls-to-action and critical PII warnings.
- **Secondary (Periwinkle):** Represents "Inferred" memory—patterns the AI has noticed but the user hasn't explicitly confirmed. It creates a softer, less urgent visual presence for suggestions.
- **Background (Dark Slate):** Provides a deep, focused workspace that reduces eye strain and allows chromatic accents to pop with high contrast.
- **Surface (Off-White):** Used for content cards, active text, and high-readability areas where complex data is presented.

## Typography
Typography is the backbone of the "precise" aesthetic. The system uses a multi-font approach to distinguish between narrative content and technical metadata.

- **Headlines (Hanken Grotesk):** Sharp and contemporary, used for section headers and major UI states.
- **Body (Inter):** Highly legible and neutral, optimized for long-form reading and conversational threads.
- **Labels (JetBrains Mono):** A monospaced font used for system-generated data, memory timestamps, and "Inferred/Stated" tags. This reinforces the "technical instrument" feel and clearly separates system metadata from human conversation.

## Layout & Spacing
This design system uses a **Fluid Grid** with fixed-width constraints for readability. The layout is structured around an 8px base unit (referenced here in 4px increments for tighter technical UI).

- **Desktop:** 12-column grid with a narrow center column (max 800px) for conversation, allowing memory nodes and sidebars to occupy the periphery.
- **Tablet:** 8-column grid; sidebars collapse into drawer menus.
- **Mobile:** Single column with 16px margins. Memory interventions appear as sticky bottom sheets to ensure "at-the-moment" visibility.

Spacing between memory nodes in the "synaptic" view is dynamic, using safe margins to prevent overlap while maintaining a connected, organic appearance.

## Elevation & Depth
Hierarchy is established through **Tonal Layers** and **Low-Contrast Outlines** rather than heavy shadows.

- **Base Layer:** Dark Slate (#303841) for the primary application background.
- **Surface Layer:** Dark Slate at 95% opacity with a 1px border (#FAFAFA at 10% opacity) for container elements.
- **Intervention Layer:** Cards requiring user action (like PII warnings) use a subtle **Vibrant Orange ambient glow** (5% opacity, 20px blur) to draw focus without being jarring.
- **Glassmorphism:** Used sparingly for sticky headers and connection line overlays to maintain context of the conversation underneath.

## Shapes
The shape language is "Geometric-Organic."

- **Nodes:** Perfect circles for memory nodes to represent neurons/data points.
- **Containers:** 0.5rem (8px) corner radius for cards and input fields, providing a modern, approachable feel.
- **Interactive Elements:** Buttons use the `rounded-lg` (1rem/16px) or full pill-shape to distinguish them from static data containers.
- **Connection Lines:** Hand-drawn-style SVG paths with a 2px stroke width. Stated connections are solid; inferred connections are dashed with a 4px gap.

## Components

### Memory Nodes & Connections
- **Stated Memory:** Vibrant Orange fill with Off-White icons. Connected by solid paths.
- **Inferred Memory:** Periwinkle fill with Dark Slate icons. Connected by dashed paths.
- **Nodes** must include a "Reject" (X) icon visible on hover (or persistent on mobile).

### Warning Cards (PII Protection)
- High-visibility cards using a Vibrant Orange top-border (4px).
- Typography uses `label-md` for the "Warning" header to denote system urgency.
- Must include two clear actions: "Redact & Send" (Primary) and "Send Anyway" (Ghost/Tertiary).

### Inline Controls
- **Approve/Reject:** Minimalist icons (Check/Cross) placed at the point of memory formation.
- **Edit:** Inline text buttons that transform the memory node into a text input area.

### Conversation Bubbles
- **AI Response:** Dark Slate background with a thin Periwinkle border to indicate "Machine" origin.
- **User Input:** Off-White background with Dark Slate text for maximum clarity.

### Memory Attribution
- Small `label-sm` tags attached to AI messages that, when clicked, highlight the specific memory nodes that informed that specific response.