# Verification and release gates

## Cloud save visibility and Android reading on 2026-11-12

- Added per-book local/queued/uploading/failed/synced status, progress, retry, and separate offline availability. Confirmed metadata is required before removing a local download. The sync loop drains edits added during uploads, retains newer remote revisions after failed uploads, and resumes when returning to the app.
- Added device-local PDF layout/zoom/rotation and flow/width/spread overrides, phone fit-width continuous defaults, explicit reading mode, footer zoom controls, visual-viewport sizing for the keyboard, and a prompt for newer remote reading positions. Fixed React removing the adapter's PDF CSS class after passage navigation, which could disable scrolling. Reimporting a missing original preserves the existing book ID and linked notes.
- Unit checks: **47 passed**, covering queue draining, upload failure/retry, upload limits, metadata acknowledgment, owner mismatch, hash-checked downloads, failed-upload conflicts, local device preferences, and missing-original recovery. Production build and typecheck passed.
- Desktop/Android browser suite: 46 of 48 passed in the full run; the corrected new navigation test and the resource-affected JBIG2 import both passed in the subsequent 10-test desktop/mobile run, together with layout, region-note, and resize checks. Initial concurrent checks exceeded this PC's memory; subsequent browser checks used one worker and builds ran separately.
- Isolated cloud transport test: **passed** with separate PC/phone browser contexts, real TUS client upload, byte hash comparison, authenticated download, page notebook, bookmark, reading-position restoration, and offline local access without an online session. This uses an intercepted service, not the live Supabase database.
- Production offline browser restart: **passed** (46.8 seconds including build), retaining notes, bookmarks, dictionary, and rendering assets after closing the browser and reopening offline. The original private 317-page PDF also **passed** sampled rendering on pages 1, 2, 159, and 317 (10 seconds including startup), with all external requests blocked.
- Live project probe: the configured project returns missing-schema responses for `is_library_owner` and `library_entries`; the private `library` bucket is unavailable. No backend initialization, owner login verification, or deployment has been completed. The dashboard could be read through native accessibility, but window actions failed; the Supabase connector remains unconnected. `supabase/inspect.sql` and expanded transaction-rolled-back storage policy checks are ready for administrator access.
- Personal books and environment files remain ignored. Existing local-development access remains enabled at the original origin so the library can be uploaded after owner setup. Actual Android installation and live two-device privacy/sync checks remain release gates.

## Floating selection tools and reversible bookmarks on 2026-11-12

- Selection tools now anchor to text in PDF, EPUB, and DOCX. Meaning expands in the popup, with compact definitions and an optional editable lookup. Geometry is transient: PDF document coordinates, DOCX ranges, and EPUB CFIs remain the persisted anchors. Popup positioning accounts for iframe offsets, scrolling, zoom, reflow, viewport edges, and the visual viewport.
- Color choices save immediately; an existing highlight's selected color removes it, while another color recolors it. Partial selections target whole annotations, and overlapping marks require choosing one. Attached notes are preserved by undo and deletion-to-Trash. Unfinished passage-note drafts persist privately in IndexedDB and can be recovered after closing the popup or reloading.
- A shared reader history covers highlight/note/bookmark changes, retains 50 actions per open reader session, preserves native undo in editors, forwards shortcuts from EPUB frames, and performs grouped changes atomically. Undo/redo and stale edits check current data before writing and respect existing sync conflicts.
- The current page/place bookmark icon toggles and fills when active. Passage bookmarks retain quoted text, have clickable markers, and remain distinct from page bookmarks. Existing records default to place bookmarks; no database migration is required. PDF matching tolerates sub-point selection rounding after zoom.
- Fixed two timing failures found by the new tests: a stale passage marker during deletion, and recovery-draft navigation before PDF loading completed. Also fixed EPUB settings being reapplied unnecessarily after opening, which could reset a restored reading location to the beginning. EPUB geometry resolves CFIs only in the matching spine section.
- Typechecking and all 36 unit tests pass. The complete 46-case desktop/mobile browser suite passes (2.7 minutes), covering prior workflows plus floating lookup, one-click colors, partial reselection, keyboard/button undo-redo, editor-local undo, draft recovery, both bookmark kinds, EPUB/DOCX reflow and reload, overlap choice, and failed removal during a real database conflict.
- The production offline-restart test passes (1.4 minutes including build). Highlights, rich page notes, page and passage bookmarks survive a fresh offline Chromium process after ordinary HTTP cache clearing; an unseen dictionary word and PDF rendering assets remain available.
- A follow-up four-case desktop/mobile run passes for compact definitions, changing the lookup word without changing the selection, and recognizing an existing passage bookmark after PDF zoom. The private 317-page PDF sample test also passes again (9.6 seconds including startup), without external requests or committing the book.
- Visually reviewed floating tools in all three formats, including mobile EPUB and desktop PDF/DOCX. The expanded popup flips or reduces its scrollable height to keep the selected word visible. Native Android selection handles and live Supabase behavior still require the separate device/service checks below.

## Page notebooks, PDF layouts, and offline dictionary on 2026-11-12

- Added one rich notebook per physical PDF page, including headings, bold/italic, lists/checklists, tags, autosave, recovery drafts, and explicit save-failure feedback. Active writing stays pinned while reading moves; closing or changing the panel flushes pending edits. Book-local search and the global note-type filter include page notes.
- Page notes reuse the existing annotation sync records. Deterministic book/page IDs keep one notebook per page; keeping both sides of a conflict combines their documents with labels. JSON backup version 2 preserves rich content, still accepts version 1, remaps by book hash, and deduplicates canonical notebook IDs. Markdown preserves formatting and CSV exports plain text.
- PDF pages-across, continuous/paginated navigation, and width/page fit are independent per-book settings. Narrow areas temporarily fall back to one column. Region mode exits after selection or Escape. Relayout preserves document coordinates, including repeated resizing; a page-level navigation inset no longer shifts restored within-page positions upward.
- Bundled the checksum-pinned Open English Wordnet 2025 archive, attribution, and licenses. Preparation generates 256 local dictionary chunks, about 38 MiB uncompressed, plus attribution/license HTML. All are precached by the production service worker. Meaning lookup keeps unfinished highlights and can append definitions to PDF page notebooks.
- `npm ls --depth=0`, typechecking, and all 32 unit tests pass. The unit coverage includes rich-content validation, page-note IDs/save/restore/conflicts, Markdown checklists, normalization, and lookups against the actual generated dictionary.
- All 34 desktop/mobile browser cases pass (1.9 minutes). New cases cover formatted-note persistence/search/edit/export/trash/restore, selection-to-definition-to-notebook flow, retained unfinished highlights, independent layout modes, narrow-screen fallback, repeated resize position preservation, an unpaired page with keyboard navigation, page-follow pinning, and retaining writing after an actual database conflict blocks saving. A follow-up desktop/mobile regression also verifies that explicitly choosing a page notebook keeps it pinned while the reader scrolls elsewhere.
- The private 317-page PDF test passes again (11.3 seconds including startup), rendering pages 1, 2, 159, and 317 with nonempty pixels and no decoder errors. All requests remain local and private screenshots remain ignored.
- The final production offline-restart test passes (50 seconds including build). It persists a formatted notebook and highlight, clears the ordinary HTTP cache, closes Chromium, starts a fresh process offline, restores both notes, and looks up a previously unseen word (`serendipity`). No external lookup request occurs. PDF font, CMap, and WebAssembly assets also remain available.
- Visually reviewed notebooks/meanings at 360, 412, 1024, and 1440 pixel widths, including a two-page desktop spread. The selection toolbar now collapses while the notebook/dictionary is open so it cannot cover those panels; returning restores the unfinished highlight. A follow-up review corrected checklist alignment for Tiptap's actual rendered markup and retained book titles on narrow screens. No document-level horizontal overflow occurred in the 360/1024 review. This does not establish native Android touch behavior.
- Installation initially hit a full C drive. Removed only the obsolete project-local dependency backup and disposable npm cache content after checking their resolved paths; retained the old lockfile backup, private files, browser profiles, and environment configuration. Installed Tiptap 3.33.1 with project-scoped npm 11.21.2; no system npm replacement or forced audit upgrade.
- Live Supabase setup, owner authentication, RLS/Storage checks, and actual cross-device sync remain unverified. No remote migration or public app deployment was performed by this feature change.

## Import repair and feature checks on 2026-11-11

| Area | Result | Evidence / limits |
| --- | --- | --- |
| Dependencies and typechecking | Passed | Repaired lockfile, `npm ls --depth=0`, `npm run typecheck` |
| Unit regressions | Passed | 26 tests: document anchors, persistence/conflicts, validation, imports, atomic backup restore |
| Desktop/mobile browser workflows | Passed | 22 tests across desktop and Pixel 7-sized Chromium; final full run 1.3 minutes |
| Personal 317-page PDF | Passed for sampled pages | Imported from outside the repo; pages 1, 2, 159, 317 rendered with nonempty pixels and no decoder errors; cover and middle page visually reviewed |
| Production offline browser restart | Passed | Build, clear ordinary HTTP cache, close/reopen Chromium offline, verify saved PDF notes and rendering assets; 48.2 seconds including build |
| Live Supabase schema/account | Blocked | Publishable credentials are present, but administrative connector and dashboard browser access are unavailable |
| Live RLS, Storage and two-device sync | Not run | Requires backend initialization, owner account and authenticated sessions |
| Physical Android selection/install | Not run | Browser emulation is not physical-device verification |

The exact reported `UnknownError Internal error` did not reproduce in the fresh local browser. Investigation did reproduce missing JBIG2 assets when loading without rendering options. Import and reader now share base-path-aware WASM/font/CMap options. A readable PDF survives cover, metadata, or cleanup failures; warnings are separate from errors. Damaged and password-protected PDFs produce actionable errors. A small synthetic upstream JBIG2 fixture covers decoding without publishing the user's book.

New browser coverage exercises mixed valid/invalid imports, duplicate rejection, failed thumbnails, metadata and cover changes, tags/status/search/sort/list/grid views, collection membership/deletion, protection of the only local copy, note edits and filters, Markdown/CSV/JSON export, JSON restore, trash/restore/permanent removal of disposable fixtures, reader search, bookmarks, theme/layout, and scanned-region notes after reload. Existing EPUB/PDF/DOCX highlight, passage navigation, typography, zoom and rotation tests remain passing.

Backup restore now validates every annotation before any write and commits the whole restore in one transaction. Duplicate IDs within a backup are skipped, existing notes are preserved, and a later sync conflict rolls back the whole restore. Four focused tests cover these cases.

The first expanded browser run used six decoder workers and hit 5-second import assertion limits. Imports now use the existing 45-second import budget and the suite uses two workers. A collection checkbox assertion now waits for its asynchronous IndexedDB update. The private PDF test initially assumed a page-number table of contents; the book has a real outline, so representative-page rendering is tested by scrolling to the page elements. These test corrections retain the feature assertions.

Read-only anonymous Supabase probes returned missing-table (`PGRST205`), missing-owner-RPC (`PGRST202`), and missing-bucket (`NoSuchBucket`) errors. This indicates initial backend setup is still needed; it is not proof that live access controls pass. The migration forces the library bucket private even if it already exists; the security SQL asserts this. SQL changes are prepared but have not been applied or executed remotely. No owner password has been created or guessed.

Local development remains usable without sign-in through ignored development-only environment overrides. Original production configuration is preserved. Git ignores personal books, note exports, environment files, browser profiles and private screenshots; only explicitly named fixture books are exceptions. Pushes run validation only; Pages publication requires a manual deploy selection after owner/privacy verification.

The source was committed and pushed to the public `hadiabdul123/book-storage` repository. The first Linux CI run passed installation, unit tests and the production build, but exposed tests that reloaded immediately after clicking Save, before asynchronous persistence completed. Collection/metadata tests now wait for their save dialogs to close, and EPUB/DOCX tests wait for the saved-highlight confirmation before checking persistence across reload. No assertion was removed and no retry was added to hide failures.

## Recovery and checks on 2026-11-11

- Checked the moved project in `C:\Users\ABDUL HADI\Downloads\book storage coding`. `.env.local` exists with non-placeholder Supabase settings and `VITE_BASE_PATH=/`; its values were preserved. `.git` exists but has no commits, recoverable objects, or remote. The old `D:\book storage coding` directory is empty.
- Found a stale lockfile and dependency directory: the manifest requested PDF.js 6 and Vitest 4, while the lockfile and installed packages still used PDF.js 5 and Vitest 3. Preserved the previous dependency directory and lockfile in ignored `.local/node_modules-before-repair` and `.local/package-lock-before-repair.json`.
- Registry access succeeded with normal network permissions. npm 10.9.3 crashed during dependency resolution (`edgesOut`); a project-scoped npm 11.21.2 invocation installed 463 packages and repaired the lockfile. The system npm was not replaced. A subsequent clean `npm.cmd ci --offline --no-audit --no-fund` succeeded with npm 10.9.3, proving the lockfile can reproduce the installation from the cache.
- `npm.cmd ls --depth=0`: passes with no invalid or missing top-level dependencies. PDF.js is 6.5.438 and Vitest is 4.1.12.
- `npm.cmd run typecheck`: passes with the installed dependencies and TypeScript 5.9.3.
- `npm.cmd test`: all 16 tests across three files pass, covering anchors, exports/statistics, backup validation, IndexedDB persistence, operation ordering, tombstones, and conflict preservation.
- `npm.cmd run build`: passes and produces the application, rendering assets, app icons, and service worker. Vite reports a non-fatal bundle-size warning.
- Fixed PDF.js 6 integration: release documents through their loading tasks and convert annotation rectangle corners through the supported viewport point API. Typed PDF documents, pages, viewports, and render tasks to expose future API mismatches during typechecking.
- Installed Playwright Chromium in `.local/playwright`. Browser tests use isolated local-device mode, overriding the private Supabase settings.
- `npm.cmd run test:e2e`: all eight tests pass across desktop and Pixel 7-sized Chromium contexts (37.8 seconds). Coverage includes empty library/collection persistence, real EPUB selection and offline reopening, real PDF annotations through zoom/rotation/reload/close/reopen without uncaught page errors, and generated DOCX annotations after reload. Updated the EPUB test to resolve replaced iframes and the PDF test to locate the Zoom combobox by its accessible role/name.
- Limited Vite dependency scanning to `index.html` and excluded local backups/browser artifacts from its file watcher. The initial library tests fell from about 47 seconds to 1.5-1.6 seconds. Browser tests allow 60 seconds per complete document scenario, accommodating their existing 45-second import waits.
- `npm audit`: six transitive/build-tool advisories (two low, four moderate) in the PWA/Workbox dependency chain; no high or critical findings. These remain open; no forced major upgrades or audit suppression were applied.

## Production offline follow-up on 2026-11-11

- Started the configured development app on `http://127.0.0.1:5173/` and checked its sign-in screen in an isolated Chromium session: HTTP 200 and no uncaught page errors. Existing Supabase settings were preserved; no login credentials were entered.
- Corrected service-worker precaching to include PDF.js's `.mjs` worker, PFB/TTF standard fonts, and WOFF fallback fonts. These file formats were absent from the old cache rules. Registration errors now appear in the browser console instead of being silently discarded.
- Added `npm.cmd run test:pwa` and a CI gate for production offline reading. The test builds to `.local/pwa-test-dist`, saves a real PDF annotation, clears Chromium's ordinary HTTP cache, closes the browser, and opens a fresh process offline with the same isolated profile. It verifies PDF text, persisted highlights/notes, passage navigation, and offline font/CMap/WASM requests. The final test passed in 6.1 seconds (32.8 seconds including the production build/server startup).
- Used a short temporary profile under `.local` after Windows Chromium failed to persist service workers under the longer generated test-results path. The same restart assertions pass with the shorter path; the successful test removes its temporary profile after closing Chromium.
- Reviewed `npm audit fix --dry-run`: its proposed PWA-plugin downgrade still reported all six existing advisories. No dependency downgrade, forced override, or audit suppression was applied.

## Not yet verified

- The Supabase administrative connection/owner account and SQL migration; live RLS/Storage, actual cross-device synchronization, and concurrent-device recovery.
- Physical Android touch selection, installed-PWA behavior on actual devices, authenticated offline recovery, the complete visual review matrix, and GitHub deployment. Local-device-mode offline browser restart is now covered by the production test above.
- Earlier network/executor restrictions recorded during initial development are no longer blocking installation and local checks. Passing local tests does not establish the live-service or physical-device results above.

## Required before calling the app release-ready

1. Keep the repaired lockfile with the source in version control, and require typecheck, unit tests, production build, and Playwright suites to pass for subsequent changes.
2. Inspect the actual desktop/mobile interface at 1440, 1024, 412, and 360 pixel widths. Check keyboard focus, dialog behavior, landscape orientation, touch targets, long titles, and long notes. Complete the blocked BookFusion screenshot review without using its artwork in the app.
3. Run the migration and security SQL checks in a dedicated project. Test owner login; unapproved login; anonymous database and Storage requests; another user’s object paths; expired tokens; and direct writes outside RPCs. All unauthorized data access must fail.
4. Sign in from separate Windows and Android sessions. Import one real EPUB and one real PDF; confirm book bytes match across devices and each annotation/bookmark opens the correct passage.
5. Annotate independently while both devices are offline. Reconnect in both orders. Verify no duplicate annotations, no lost note text, correct conflict preservation, no resurrected deletions, and exact position choices. Repeat with two tabs and a failed upload.
6. Install the production PWA, download books, close it, disable networking, reopen, annotate, restart again, reconnect, and verify propagation. Exercise service-worker updates with pending edits and fresh auth after offline expiry.

## Physical Android selection matrix

Use Chrome stable and the installed PWA on an actual Android phone. Record the model, Android/Chrome versions, fixture, steps, and result; emulation is insufficient.

| Case | Expected result |
| --- | --- |
| Long press and drag both native handles | Selection follows fingers without accidental page turns |
| Select across inline italics, links, and line breaks | Exactly the selected quote is stored and highlighted |
| Extend selection while the floating toolbar is visible | Stored anchor follows the updated selection |
| Tap a color, open the keyboard, write a note, save | Original passage remains selected correctly |
| EPUB font-size/theme/page-layout/orientation changes | Persisted highlight and jump target remain attached |
| PDF zoom/rotation/device pixel-ratio changes | Highlight stays aligned to the original glyphs |
| PDF multi-column and multi-page selections | No unrelated column/page content is included |
| Scanned PDF region drag | Rectangle survives zoom, reload, and device sync |
| Overlapping highlights | Text can still be selected; all notes remain editable in the list |
| Rapid save, close/reopen, offline restart | Saved annotations persist without duplicates |

## Additional compatibility coverage

Add redistributable fixtures for RTL/non-Latin EPUBs, fixed-layout EPUBs, multi-column and rotated PDFs, scanned pages, image-heavy books, repeated identical quotes, and long documents. Include malformed files and complex DOCX tables/footnotes. Keep fixture provenance and relevant permissions alongside the files.

The initial suite is a starting corpus, not evidence of exhaustive ebook compatibility. Never label mobile highlighting reliable until the physical-device cases have actually passed.
