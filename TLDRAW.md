# tldraw Research - Integration into remote-claude Dashboard

Research date: 2026-03-11\
tldraw version: 4.4.1\
Use case: Screenshot annotation, mockup/wireframing canvas in a React + Vite + Tailwind + Zustand PWA dashboard

---

## 1. Package Ecosystem

### Core Package

```
tldraw@4.4.1
```

Single install gets you everything. Internally it bundles:

| Package | Unpacked Size | Role |
|---------|--------------|------|
| `tldraw` | 11.1 MB | UI, tools, shapes, export -- the full monty |
| `@tldraw/editor` | 7.1 MB | Core editor engine, canvas rendering |
| `@tldraw/store` | 1.5 MB | Reactive store (signals-based, NOT Redux/Zustand) |

**Total unpacked: ~11 MB** (tldraw is the top-level, others are its deps)

### Dependencies tldraw pulls in

- `radix-ui` (already in our web/package.json -- no extra cost)
- `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit` (rich text editing inside shapes)
- `hotkeys-js` (keyboard shortcut handling)
- `idb` (IndexedDB wrapper for persistence)
- `lz-string` (compression for snapshots)
- `classnames` (CSS class util)

**Peer deps:** React 18.2+ or 19.2+ and react-dom (we have `latest` -- fine)

### Optional Packages

| Package | Purpose |
|---------|---------|
| `@tldraw/sync` | Multiplayer/realtime collaboration |
| `@tldraw/assets` | Self-host fonts/icons instead of CDN |

We don't need `@tldraw/sync` for our use case.

### npm Stats

- 45.7k GitHub stars, 3.1k forks
- Used by 1.9k dependents
- Active development (v4.4.1 released 2026-03-09)

---

## 2. License -- THIS IS THE BIG ONE

**tldraw is NOT MIT. It uses a custom commercial license.**

### What's free

- Development and prototyping -- no license key needed
- Internal tools that aren't user-facing (debatable for our case)

### What requires payment

- **Any production deployment** -- whether commercial or not
- Without a license key, a **watermark is displayed** on the canvas
- You cannot remove or hide the watermark without a valid key

### What this means for us

Our dashboard is a production tool (even if internal). Options:

1. **Buy a license** -- pricing not publicly listed, contact tldraw sales
2. **Use tldraw with watermark** -- functionally works, just has branding
3. **Use Excalidraw instead** -- MIT licensed, no restrictions (see section 8)

**Verdict:** The license is a real consideration. If this is an internal tool with a handful of users, the watermark might be acceptable. For anything customer-facing or if the watermark is annoying, you need to pay or pick an alternative.

---

## 3. React Integration

### Basic Setup

```bash
bun add tldraw
```

```tsx
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

function WhiteboardPanel() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw
        persistenceKey="rclaude-whiteboard"
        onMount={(editor) => {
          // editor instance available here
        }}
      />
    </div>
  )
}
```

### Container Requirements

tldraw fills its parent container (width/height 100%). The parent **must have explicit dimensions**. Inside a modal/dialog, this means the dialog needs a fixed size or `position: fixed; inset: 0` on the wrapper.

### Accessing the Editor

Two patterns:

```tsx
// Pattern 1: onMount callback (simple, for initialization)
<Tldraw onMount={(editor) => {
  // do stuff with editor
}} />

// Pattern 2: useEditor hook (for child components inside Tldraw)
function ToolbarOverlay() {
  const editor = useEditor()
  return <button onClick={() => editor.selectAll()}>Select All</button>
}

<Tldraw>
  <ToolbarOverlay />
</Tldraw>
```

### State Management -- No Zustand Conflict

tldraw uses its own reactive store (`@tldraw/store`) based on signals. It does NOT use Redux, Zustand, or React context for its internal state. **No conflict with our Zustand stores.** They operate in completely separate worlds.

To bridge tldraw state into Zustand (e.g., track "has unsaved changes"), use the `editor.store.listen()` API:

```tsx
onMount={(editor) => {
  editor.store.listen((entry) => {
    // entry.changes contains what changed
    // update your Zustand store here if needed
  })
}}
```

### SSR / Vite Considerations

tldraw is client-only (Canvas API, DOM manipulation). With Vite (no SSR), this is a non-issue. If you ever add SSR, wrap in dynamic import or `React.lazy()`.

### Works in Modals

Yes, but the modal container must have explicit dimensions. A fullscreen overlay works best:

```tsx
<dialog style={{ position: 'fixed', inset: 0, padding: 0 }}>
  <Tldraw persistenceKey="modal-canvas" />
</dialog>
```

---

## 4. Image / Screenshot Workflow

### Clipboard Paste (Cmd+V)

**Built-in.** tldraw handles `paste` events out of the box. Users can:
- Screenshot (Cmd+Shift+4 on macOS) and paste directly onto canvas
- Copy an image from any app and paste it
- Paste image URLs (tldraw fetches and embeds them)

No custom code needed for basic clipboard paste.

### Programmatic Image Creation

To add a screenshot from code (e.g., after `getDisplayMedia` capture):

```tsx
import { AssetRecordType, createShapeId } from 'tldraw'

async function addImageToCanvas(editor, imageBlob: Blob, filename: string) {
  // 1. Create a blob URL or data URL
  const dataUrl = await blobToDataUrl(imageBlob)

  // 2. Get image dimensions
  const img = new Image()
  await new Promise((resolve) => {
    img.onload = resolve
    img.src = dataUrl
  })

  // 3. Create asset record
  const assetId = AssetRecordType.createId()
  editor.createAssets([{
    id: assetId,
    type: 'image',
    typeName: 'asset',
    props: {
      name: filename,
      src: dataUrl,
      w: img.naturalWidth,
      h: img.naturalHeight,
      mimeType: imageBlob.type,
      isAnimated: false,
    },
    meta: {},
  }])

  // 4. Create image shape on canvas
  const shapeId = createShapeId()
  editor.createShape({
    id: shapeId,
    type: 'image',
    x: 100,
    y: 100,
    props: {
      assetId,
      w: img.naturalWidth,
      h: img.naturalHeight,
    },
  })

  // 5. Zoom to fit the new image
  editor.zoomToFit()
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}
```

### Screen Capture Integration

```tsx
async function captureAndAnnotate(editor) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { mediaSource: 'screen' },
  })
  const track = stream.getVideoTracks()[0]
  const imageCapture = new ImageCapture(track)
  const bitmap = await imageCapture.grabFrame()
  track.stop()

  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)

  const blob = await new Promise<Blob>((r) =>
    canvas.toBlob((b) => r(b!), 'image/png')
  )

  await addImageToCanvas(editor, blob, 'screenshot.png')
}
```

**Note:** `getDisplayMedia` requires user gesture and HTTPS. Works fine in a PWA context.

### Drag and Drop

Built-in. Users can drag image files from Finder/Explorer directly onto the canvas. No custom code needed.

### Image Storage

tldraw offers three storage strategies:

| Strategy | How | Persistence | Production-ready |
|----------|-----|-------------|-----------------|
| **Inline base64** (default) | Data URLs embedded in store | Lost on page refresh (unless `persistenceKey` used) | No -- bloats store JSON |
| **IndexedDB** | Auto with `persistenceKey` | Survives refresh, per-browser | Good for single-user |
| **Custom TLAssetStore** | Upload to S3/server, store URL | Server-side | Yes |

For our use case, **IndexedDB via `persistenceKey`** is the right starting point. Images persist locally per browser. If we later want to share annotated screenshots across sessions or send them to the concentrator, implement a custom `TLAssetStore` that uploads to the server.

---

## 5. Export / Output

### Export as Image (PNG/SVG/JPEG)

```tsx
import { exportAs } from 'tldraw'

// Export selected shapes as PNG
async function exportSelection(editor) {
  const selectedIds = editor.getSelectedShapeIds()
  await exportAs(editor, selectedIds, {
    format: 'png', // 'png' | 'svg' | 'jpeg' | 'webp' | 'json'
    // quality: 1,  // for jpeg/webp
    // scale: 2,    // retina
  })
  // triggers download
}

// Export everything on current page
async function exportAll(editor) {
  const allShapeIds = editor.getCurrentPageShapeIds()
  await exportAs(editor, [...allShapeIds], { format: 'png' })
}
```

### Get as Blob (for sending to server, not downloading)

```tsx
import { getSvgAsImage, exportToBlob } from 'tldraw'

// Get PNG blob for upload
async function getCanvasBlob(editor): Promise<Blob> {
  const shapeIds = editor.getCurrentPageShapeIds()
  const blob = await exportToBlob({
    editor,
    ids: [...shapeIds],
    format: 'png',
    opts: { scale: 2 },
  })
  return blob
}
```

### Save/Load as JSON (for persistence)

```tsx
import { getSnapshot, loadSnapshot } from 'tldraw'

// Save
function saveCanvas(editor) {
  const { document, session } = getSnapshot(editor.store)
  localStorage.setItem('canvas-doc', JSON.stringify(document))
  // 'session' = camera position, selection -- optional to save
}

// Load
function loadCanvas(editor) {
  const saved = localStorage.getItem('canvas-doc')
  if (saved) {
    loadSnapshot(editor.store, { document: JSON.parse(saved) })
  }
}
```

The snapshot JSON includes all shapes, assets (as data URLs if using inline storage), pages, and bindings. It's fully serializable and can be sent to the concentrator for storage.

---

## 6. Mobile / Touch Support

### Touch Gestures

tldraw has solid touch support:

- **Single finger** -- draw, select, move shapes
- **Two-finger pinch** -- zoom in/out
- **Two-finger pan** -- scroll canvas
- **Long press** -- context menu

### Apple Pencil / Stylus

Supported. tldraw detects pen input and can differentiate from touch (pressure sensitivity for draw tool).

### Mobile Safari PWA

**Works but has known issues:**

1. **Viewport bounce** -- Safari's keyboard viewport shift can cause problems (we already know this from our iOS Safari experience -- see MEMORY.md). tldraw recommends the viewport meta tag: `width=device-width, initial-scale=1, viewport-fit=cover`

2. **Performance** -- Canvas rendering is GPU-accelerated. Performance is acceptable on modern iPhones/iPads but noticeably slower than desktop for complex drawings (hundreds of shapes).

3. **Toolbar density** -- tldraw's default toolbar is designed for desktop. On small phone screens, it can feel cramped. Tablet is fine.

**Recommendation:** For mobile use, consider hiding tldraw's default UI and building a minimal custom toolbar with larger touch targets.

---

## 7. Customization

### Hide Default UI

```tsx
// Completely headless -- bring your own UI
<Tldraw hideUi />

// Or selectively override components
<Tldraw
  components={{
    Toolbar: null,        // hide toolbar
    PageMenu: null,       // hide page switcher
    MainMenu: null,       // hide hamburger menu
    StylePanel: null,     // hide style panel
    NavigationPanel: null, // hide minimap
    // ContextMenu: MyCustomContextMenu,
  }}
/>
```

### Dark Theme

tldraw supports dark mode via the editor API:

```tsx
<Tldraw onMount={(editor) => {
  editor.user.updateUserPreferences({ colorScheme: 'dark' })
}} />
```

Or follow system preference:

```tsx
editor.user.updateUserPreferences({ colorScheme: 'system' })
```

**Custom theming (Tokyo Night):** tldraw uses CSS variables for colors. You can override them:

```css
.tl-container[data-color-scheme='dark'] {
  --color-background: #1a1b26;       /* Tokyo Night bg */
  --color-text: #c0caf5;             /* Tokyo Night fg */
  --color-panel: #24283b;            /* Panel bg */
  /* ... more variables */
}
```

The full list of CSS variables isn't well-documented -- you'd need to inspect the source CSS or the rendered DOM to find all overridable variables.

### Keyboard Shortcuts

tldraw registers its own shortcuts (V for select, D for draw, T for text, etc.). These are scoped to the tldraw container and only active when it has focus. **No conflict with your app's shortcuts** unless both are listening on `document`.

To customize shortcuts:

```tsx
<Tldraw
  overrides={{
    actions(editor, actions) {
      // Modify or remove default actions
      delete actions['toggle-grid']
      return actions
    },
  }}
/>
```

---

## 8. Alternatives Comparison

### Excalidraw vs tldraw (Primary Comparison)

| Aspect | tldraw 4.4.1 | Excalidraw 0.18.0 |
|--------|-------------|-------------------|
| **License** | Custom commercial (watermark without key) | **MIT** (fully free) |
| **GitHub Stars** | 45.7k | 119k |
| **Unpacked Size** | 11.1 MB | 44.6 MB (!) |
| **React Version** | 18.2+ or 19.2+ | 17+ / 18+ / 19+ |
| **Visual Style** | Clean, modern | Hand-drawn / sketchy |
| **Dark Mode** | Yes | Yes |
| **Clipboard Paste** | Built-in | Built-in |
| **Export** | PNG, SVG, JPEG, WebP, JSON | PNG, SVG, JSON, clipboard |
| **Touch Support** | Good | Good |
| **Collaboration** | @tldraw/sync (self-host or their server) | Built-in (their server or self-host) |
| **Custom Shapes** | Full shape system with ShapeUtil | Plugin-based |
| **State Management** | Custom reactive store (signals) | Zustand-like internal store |
| **Persistence** | IndexedDB / snapshots / custom | Built-in local storage |
| **API Surface** | Very large, well-documented | Moderate, adequate |

**Excalidraw's advantages:**

- MIT license -- zero licensing concerns
- Much larger community (119k stars)
- Hand-drawn aesthetic is distinctive and beloved
- Simpler API for basic use cases
- Well-proven in production (Google Cloud, Meta, Notion, Obsidian use it)

**tldraw's advantages:**

- Cleaner, more professional look (matters for a monitoring dashboard)
- Better programmatic API (Editor class is comprehensive)
- Reactive store is more powerful for integration
- Better documentation for advanced use cases
- Smaller bundle (11 MB vs 45 MB unpacked)
- More active iteration on the SDK specifically

### Other Alternatives

| Library | License | Size | Best For | Drawback for Us |
|---------|---------|------|----------|-----------------|
| **Fabric.js** 7.2 | MIT | 24.6 MB | Low-level canvas manipulation | No built-in drawing tools, arrows, text boxes. You build everything yourself. |
| **Konva.js** 10.2 | MIT | 1.4 MB | Lightweight canvas shapes | Even more low-level than Fabric. No whiteboard UI at all. |
| **react-sketch-canvas** 6.2 | MIT | 0.4 MB | Simple freehand drawing | Too basic -- no shapes, arrows, text, image support. Just pen strokes. |

**Bottom line:** The real choice is between **tldraw** and **Excalidraw**. Fabric/Konva are canvas primitives, not whiteboard tools -- you'd spend weeks building what tldraw/Excalidraw give you out of the box.

### Recommendation

| Scenario | Pick |
|----------|------|
| License cost is a non-issue | **tldraw** -- better API, cleaner look, smaller bundle |
| Must be free / MIT | **Excalidraw** -- fully open, proven at scale |
| Want hand-drawn aesthetic | **Excalidraw** |
| Want professional/clean aesthetic | **tldraw** |
| Minimal bundle size matters most | **tldraw** (11 MB vs 45 MB) |

---

## 9. Integration Architecture for remote-claude

### Lazy Loading (Critical)

tldraw is heavy. It must NOT be in the main bundle. Code-split it:

```tsx
import { lazy, Suspense } from 'react'

const WhiteboardPanel = lazy(() => import('./components/whiteboard-panel'))

function App() {
  const [showWhiteboard, setShowWhiteboard] = useState(false)

  return (
    <>
      <button onClick={() => setShowWhiteboard(true)}>Open Whiteboard</button>
      {showWhiteboard && (
        <Suspense fallback={<div>Loading canvas...</div>}>
          <WhiteboardPanel onClose={() => setShowWhiteboard(false)} />
        </Suspense>
      )}
    </>
  )
}
```

Vite handles the code splitting automatically with dynamic `import()`.

### Where It Lives in the UI

Options ranked by UX:

1. **Full-page overlay** (like the terminal) -- best for actual drawing work. Toggle with a button in the session detail toolbar. Escape to close.

2. **Resizable side panel** -- awkward. Canvas tools need space.

3. **New tab/route** -- works but loses context of the session you're annotating.

**Recommended: Full-page overlay**, matching the existing web-terminal pattern.

### Persistence Strategy

```
Phase 1: persistenceKey per session (IndexedDB, zero server work)
Phase 2: getSnapshot() -> send JSON to concentrator -> store in session data
Phase 3: Export as PNG blob -> attach to session as artifact
```

Phase 1 is enough to start. Each session gets its own canvas that persists in the browser.

### Sending Annotated Image to Claude Session

The most useful workflow: annotate a screenshot, export as PNG, and paste it into the Claude session input.

```tsx
async function sendToSession(editor, sessionId: string) {
  const blob = await exportToBlob({
    editor,
    ids: [...editor.getCurrentPageShapeIds()],
    format: 'png',
    opts: { scale: 2 },
  })

  // Convert to base64 for the WS message
  const base64 = await blobToBase64(blob)

  // Send via existing WS infrastructure
  wsClient.send({
    type: 'session_input',
    sessionId,
    payload: {
      type: 'image',
      data: base64,
      mimeType: 'image/png',
    },
  })
}
```

This depends on the concentrator supporting image payloads in session input -- which would be a new feature.

---

## 10. PWA Considerations

### Offline Support

tldraw works fully offline once loaded. All drawing is client-side canvas operations. With `persistenceKey`, drawings survive browser close/reopen.

The main concern is **initial load** -- tldraw's JS chunk needs to be cached by the service worker. Add the lazy-loaded chunk to your SW precache list or use a runtime caching strategy.

### Service Worker Caching

```js
// In your SW config, cache the tldraw chunk
// With Vite's workbox plugin:
{
  runtimeCaching: [{
    urlPattern: /tldraw.*\.js$/,
    handler: 'CacheFirst',
    options: { cacheName: 'tldraw-assets' },
  }]
}
```

### Performance Impact

- **Memory:** tldraw editor allocates ~20-40 MB on creation. Fine for desktop, worth noting for low-end mobile.
- **CPU:** Idle tldraw canvas is near-zero CPU. Active drawing uses requestAnimationFrame -- smooth on modern hardware.
- **First load:** The JS chunk is ~2-3 MB gzipped (estimated from unpacked 11 MB). On fast connections this is <1s, on 3G it's 5-10s. Lazy loading ensures this cost is only paid when the user opens the whiteboard.

---

## 11. Gotchas and Caveats

### Things that will bite you

1. **License watermark** -- Shows up in production without a key. Can't be CSS-hidden without violating the license.

2. **CSS conflicts** -- `tldraw/tldraw.css` includes global-ish styles. Import it only in the whiteboard component, not globally. Watch for conflicts with Tailwind's reset.

3. **Container sizing** -- If the parent doesn't have explicit dimensions, tldraw renders as 0x0. Always verify the container has height.

4. **Asset storage bloat** -- Default inline base64 storage means pasted screenshots are stored as full data URLs in IndexedDB. A 2 MB screenshot becomes a ~2.7 MB base64 string. Multiple screenshots = significant storage. Plan for a custom asset store if heavy use is expected.

5. **Mobile text input** -- Text editing on mobile Safari can trigger viewport shifting (we know this pain). tldraw's text tool on iOS is functional but not great.

6. **Font loading** -- tldraw loads IBM Plex and Shantell Sans by default (from CDN or bundled). This is 200-400 KB extra. Can be customized to use our existing Geist fonts.

7. **Keyboard shortcut scope** -- tldraw uses `hotkeys-js` which binds at the document level. If the whiteboard is in an overlay, shortcuts might leak to the app underneath. Test thoroughly.

8. **React 19 peer dep** -- tldraw requires `^19.2.1` for React 19. If our `latest` resolves to an earlier 19.x, there could be a peer dep warning. Pin if needed.

---

## 12. Minimal Integration Example

Complete component ready to drop into the dashboard:

```tsx
// web/src/components/whiteboard-panel.tsx
import { useCallback, useRef } from 'react'
import { Tldraw, getSnapshot, loadSnapshot, exportToBlob, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

interface WhiteboardPanelProps {
  sessionId: string
  onClose: () => void
}

export default function WhiteboardPanel({ sessionId, onClose }: WhiteboardPanelProps) {
  const editorRef = useRef<Editor | null>(null)

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    editor.user.updateUserPreferences({ colorScheme: 'dark' })
  }, [])

  const handleExportPng = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    const ids = editor.getCurrentPageShapeIds()
    if (ids.size === 0) return
    const blob = await exportToBlob({
      editor,
      ids: [...ids],
      format: 'png',
      opts: { scale: 2 },
    })
    // Download or send to session
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `annotation-${sessionId}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, [sessionId])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999 }}>
      <div style={{
        position: 'absolute', top: 8, right: 8, zIndex: 10000,
        display: 'flex', gap: 8,
      }}>
        <button onClick={handleExportPng}>Export PNG</button>
        <button onClick={onClose}>Close</button>
      </div>
      <Tldraw
        persistenceKey={`whiteboard-${sessionId}`}
        onMount={handleMount}
      />
    </div>
  )
}
```

---

## 13. Decision Matrix

| Criterion | Weight | tldraw | Excalidraw | Notes |
|-----------|--------|--------|------------|-------|
| License freedom | High | 3/10 | 10/10 | tldraw's commercial license is restrictive |
| API quality | High | 9/10 | 7/10 | tldraw's Editor API is excellent |
| Bundle size | Medium | 7/10 | 4/10 | tldraw 11 MB vs Excalidraw 45 MB |
| Visual fit (dashboard) | Medium | 8/10 | 6/10 | tldraw looks more professional |
| Clipboard paste | High | 9/10 | 9/10 | Both work out of the box |
| Export | High | 9/10 | 8/10 | tldraw has more formats |
| Mobile/touch | Medium | 7/10 | 7/10 | Both adequate |
| Community/longevity | Medium | 7/10 | 9/10 | Excalidraw is MIT + huge community |
| Customization | Medium | 9/10 | 7/10 | tldraw's component overrides are powerful |

**If license cost is acceptable:** tldraw wins on API, aesthetics, and bundle size.\
**If must be free:** Excalidraw is the only real option among whiteboard tools.

---

## 14. Next Steps

1. **Decide on licensing** -- Check tldraw pricing (contact sales or check tldraw.dev/pricing). If it's per-seat and we have <5 users, it might be cheap enough to not matter.

2. **Prototype** -- `bun add tldraw` in web/, create the lazy-loaded component, test clipboard paste + export. Should take ~2 hours to validate.

3. **Test mobile** -- Open the prototype on iPad/iPhone in PWA mode. Verify touch gestures and performance are acceptable.

4. **If tldraw license is a blocker** -- Same prototype with `@excalidraw/excalidraw`. API is different but the integration pattern is similar.
