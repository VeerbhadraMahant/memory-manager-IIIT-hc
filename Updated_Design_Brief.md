
# Negotiated AI Memory — Updated Design Brief
*(Graph-first Experience)*

## Design Vision

Negotiated AI Memory should not feel like a database or a settings page.

Instead, every memory becomes part of a living **Memory Graph**, allowing users to see, negotiate, edit and explore the AI's understanding in real time.

The visual language should be inspired by neural networks and knowledge graphs while remaining clean, premium and approachable.

---

# Brand Direction

The design language follows the **Synaptic Precision** design system.

Core personality:

- Transparent
- Human-controlled AI
- Premium
- Calm
- Technical
- Trustworthy

The interface should resemble a modern AI operating system rather than a traditional chatbot.

---

# Primary Experience

```
Chat
      ↓
Memory Negotiation
      ↓
Memory Graph Animation
      ↓
Inspect → Edit → Trace → Chat with Memory
      ↓
Memory List (Accessibility + Bulk Management)
```

The graph is the primary interaction.

The list exists for accessibility, keyboard navigation and bulk editing.

---

# Color System

Use ONLY these primary brand colours.

| Purpose | Color |
|---------|---------|
| Background | #303841 |
| Inferred Memory | #C2CEF2 |
| Stated / Confirmed Memory | #F77A25 |
| Surface / Cards | #FAFAFA |

These colours should be consistently used across graph nodes, UI components and animations.

## Category Colours

Rather than introducing new colours, every category derives from the four brand colours.

### Personal

Periwinkle (#C2CEF2)

### Work

Orange (#F77A25)

### Projects

Orange with stronger glow

### Preferences

Periwinkle with lower saturation

### General

Dark Slate (#303841)

Cards and floating panels remain Off White (#FAFAFA).

---

# Memory Graph

The graph is the visual representation of AI memory.

Every stored memory becomes a node.

Nodes are grouped by category.

Each node contains

- title
- context
- metadata
- source chat
- confidence
- timestamp
- memory summary
- child memories

Example

You

→ Work

→ AI Study Assistant

→ Backend

→ FastAPI

→ Embeddings

---

# Permanent vs Temporary Memories

Memory persistence is represented visually.

Permanent Memory

- Solid connection
- Stable glow
- Always visible

Temporary Memory

- Animated dotted connection
- Slight transparency
- Gradually fades until expiry

No additional badges should be required.

---

# Context Highlighting

When the user submits a prompt

the retrieval engine should highlight related nodes.

95–100%

Large orange glow

60–90%

Medium glow

20–60%

Soft pulse

Unrelated nodes

Fade slightly

Users immediately understand which memories influence the response.

---

# Expandable Nodes

Clicking a node should animate into its hierarchy.

Animation

Parent node

↓

Children expand radially

↓

Grandchildren appear

↓

Connection paths animate

The graph should feel alive.

---

# Rich Subnodes

Each node can contain

- Facts
- Context
- Timeline
- Related memories
- Source chats
- Attachments
- Confidence
- Summary
- Status

---

# Hover Actions

Hovering over a node reveals

- Ask AI
- Edit
- Delete
- History
- Summary
- Add Child
- Prune Branch

---

# Chat With Memory

Hovering any node shows

**Ask About This Memory**

A contextual chat opens using only that node.

---

# Multi-node Selection

Enable

Selection Mode

Users can select multiple nodes.

The selected nodes become the only context sent to the AI.

This creates transparent context selection.

---

# Chat History Integration

Every node stores

- originating prompt
- assistant reply
- negotiation history
- edits
- retrieval history

Clicking History jumps directly to that conversation.

---

# Node Editing

Every node supports

- Rename
- Edit
- Delete
- Add Child
- Remove Child
- Prune Branch
- Merge
- Split
- Convert Temporary ↔ Permanent
- Generate Summary

No settings page should be required.

---

# Memory Summary

Every node supports AI-generated summaries.

The summary should include

- Current state
- Important facts
- Related memories
- Active work
- Stale information

---

# Interaction Principles

1. Memory should be visible.
2. Relationships are more valuable than lists.
3. Users should always know why memories were retrieved.
4. Every memory is traceable to its source chat.
5. Graph animations should communicate relationships.
6. Users can edit, delete, summarise and prune directly from the graph.
7. Temporary and permanent memories are distinguished using dotted and solid connections.
8. Graph interactions should remain accessible through an equivalent list view.

---

# Visual Style

Following the Synaptic Precision design language:

- Dark Slate background (#303841)
- Off White floating surfaces (#FAFAFA)
- Orange for explicit/stated memories (#F77A25)
- Periwinkle for inferred/contextual memories (#C2CEF2)
- Organic node layout
- Smooth force-directed animations
- Low-contrast outlines
- Soft ambient glows
- Minimal shadows
- Rounded modern panels
- Premium enterprise aesthetic

The final interface should resemble a living AI memory network rather than a dashboard.
