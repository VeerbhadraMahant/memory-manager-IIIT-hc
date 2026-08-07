# Interactive Memory Graph Implementation Prompt

## Objective

Redesign the current memory graph into an interactive hierarchical knowledge graph inspired by neural networks and mind maps. The graph should feel alive, organic, and exploratory rather than a static collection of disconnected cards.

## Overall Concept

- Start with a single central node (**You**).
- Progressively reveal memory hierarchy through interaction.
- Encourage exploration rather than information overload.

## Graph Behaviour

### Initial State

```text
YOU
```

Only the central node is visible with a subtle breathing animation.

### First Expansion

Clicking the central node expands to:

```text
YOU
├── Personal
├── Work
├── Projects
├── Preferences
├── General
└── Health
```

Use:
- Scale animation
- Fade-in
- Spring motion
- Animated connection lines

### Progressive Disclosure

Each category expands independently.

Example:

```text
Projects
├── AI Study Assistant
├── Library System
└── Personal Website
```

### Infinite Expansion

Every node can contain unlimited children.

## Node Behaviour

Hover:
- Summary
- Child count
- Memory type
- Last updated

Click:
- Expand children

Double-click:
- Open Inspector

Right-click:
- Edit
- Delete
- Merge
- Split
- Add Child
- Generate Summary
- View History

## Organic Layout

- Force-directed radial layout
- Connected nodes remain close
- Nodes repel naturally
- Curved SVG connection paths

## Connections

- Permanent memories → Solid lines
- Temporary memories → Animated dotted lines
- Strong relationships → Thick lines
- Weak relationships → Thin lines

Hovering highlights connected paths.

## Expand Animation

1. Parent enlarges
2. Paths animate
3. Child nodes appear
4. Labels fade in
5. Layout rebalances smoothly

## Collapse Animation

- Fade children
- Retract edges
- Recenter graph

## Camera

Automatically pan and zoom to selected nodes while preserving context.

## Retrieval Highlight

When a prompt is submitted:

```text
Continue my AI project.
```

Highlight retrieval path.

```text
Projects
└── AI Study Assistant
    └── FastAPI
        └── Backend
```

Glow nodes according to retrieval confidence.

## Inspector Panel

Display:
- Summary
- Metadata
- Category
- Source Chat
- Confidence
- Scope
- Created
- Updated

Actions:
- Edit
- Delete
- Add Child
- Merge
- Split
- Chat About Memory
- View History

## Categories

- Personal
- Work
- Projects
- Preferences
- Health
- Learning
- General

## Color Palette

| Element | Color |
|---------|--------|
| Background | #303841 |
| Primary Memory | #F77A25 |
| Secondary Memory | #C2CEF2 |
| Surface | #FAFAFA |

Differentiate categories using glow, icons, borders, and gradients rather than additional colors.

## Hover Actions

- Summary
- History
- Ask AI
- Edit
- Delete

## Multi-Selection

Allow Shift-click or Selection Mode.

Selected nodes become the retrieval context for AI.

## Search

Searching should:
- Zoom to node
- Highlight path
- Pulse node
- Dim unrelated branches

## Performance

- Render only expanded branches
- Virtualize collapsed branches
- Maintain smooth 60 FPS animations

## Inspiration

- Obsidian Graph
- Cosmos
- Figma Mind Maps
- Apple interactions
- Linear
- Neural network visualizations

The graph should feel like exploring a living memory network rather than browsing static cards.
