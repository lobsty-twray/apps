# Lobsty Design Tokens

Shared CSS custom properties (design tokens) for all Lobsty apps.

## Usage

All apps import this via the `shared-assets` Docker service:

```html
<link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
```

The CSS is served at `http://shared-assets:3000/design-tokens.css` inside the Docker network.

## Variables

### Backgrounds
| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#0a0a0f` | Page background |
| `--surface` | `rgba(255,255,255,0.03)` | Card/section backgrounds |
| `--glass` | `rgba(255,255,255,0.05)` | Glassmorphism fill |
| `--glass-border` | `rgba(255,255,255,0.08)` | Glassmorphism borders |
| `--glass-hover` | `rgba(255,255,255,0.1)` | Hover state for glass elements |

### Text
| Token | Value | Use |
|-------|-------|-----|
| `--text` | `#e8e8f0` | Primary text |
| `--text-dim` | `#888899` | Secondary/muted text |

### Accent
| Token | Value | Use |
|-------|-------|-----|
| `--accent` | `#7c3aed` | Primary accent (purple) |
| `--accent2` | `#2563eb` | Secondary accent (blue) |
| `--accent-light` | `#a78bfa` | Light accent for highlights |
| `--gradient` | `linear-gradient(135deg, #7c3aed, #2563eb)` | Brand gradient |
| `--glow` | `rgba(124,58,237,0.3)` | Purple glow/shadow |
| `--glow2` | `rgba(37,99,235,0.3)` | Blue glow/shadow |

### Status
| Token | Value | Use |
|-------|-------|-----|
| `--green` | `#34d399` | Success |
| `--red` | `#f87171` | Error/danger |
| `--yellow` | `#fbbf24` | Warning |

### Spacing & Radius
| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | `8px` | Small elements (buttons, inputs) |
| `--radius-md` | `14px` | Cards, panels |
| `--radius-lg` | `16px` | Large cards |
| `--radius-xl` | `20px` | Modals, hero sections |
| `--min-touch` | `44px` | Minimum touch target size |

### Typography
| Token | Value |
|-------|-------|
| `--font` | Inter, system fallbacks |

## Base Resets Included

The file includes a universal box-sizing reset and sets body defaults (font, background, color, min-height).

## Adding New Tokens

1. Edit `~/apps/shared/design-tokens.css`
2. Rebuild: `cd ~/apps && sudo docker compose up -d --build shared-assets`
3. All apps pick it up on next page load (no rebuild needed for consumers since it is fetched at runtime)

Only add tokens that are used by 2+ apps. App-specific values stay in the app.
