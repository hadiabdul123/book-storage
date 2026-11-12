# Leafmark

A personal React + TypeScript reading PWA for Windows and Android. EPUB, PDF, and DOCX import; a cover bookshelf and collections; linked highlights and notes; offline downloads; and Supabase synchronization. Original interface inspired by BookFusion’s organization and reading workflow.

## Current verification status

Dependency installation has been repaired after the move to the C drive. The reader now includes formatted PDF page notebooks, one/two-page reading modes, and a bundled offline English dictionary. See [verification notes](docs/VERIFICATION.md) for test results and remaining release gates. The live private Supabase schema and owner allowlist are configured; database access controls and anonymous API rejection have passed. Owner sign-in and a real book upload are verified. Cross-device download/synchronization and physical Android touch behavior still need verification.

## Open the hosted reader

The deployed app is [Leafmark](https://hadiabdul123.github.io/book-storage/). Sign in with the configured reader account; the public source and app shell do not expose the private library. On Android Chrome, open the link and use the menu to install the app. Open a book while online to download its offline copy. On first use, leave the app open until it reports that the reader and dictionary are ready offline; the initial asset download can take a few minutes.

## Run on your PC

Use Node.js 22.18 or newer. In PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open the localhost URL printed by Vite. Without Supabase configuration the app runs in clearly labeled **local-device mode**. Imports and annotations are real and persist in IndexedDB. This is useful for reader testing; cross-device synchronization and authenticated access require the configuration below. Keep original files and export annotations before clearing browser data.

This PC now uses the private Supabase settings in ignored `.env.local` for development. The temporary empty cloud overrides were removed after configuring the owner account. Sign in using the owner email and the password created in Supabase; refresh the existing browser origin to retain its local library.

`predev` and `prebuild` prepare local PDF fonts, character maps, WebAssembly assets, app icons, and dictionary chunks. No rendering dependency or dictionary lookup is loaded from a CDN. Keep `package-lock.json` with the source and use `npm ci` for repeatable installs. The project-local npm cache lives in the ignored `.local/npm-cache` directory.

### Moving or recovering this project

Keep the source, `package.json`, `package-lock.json`, hidden `.git` folder, and your private `.env.local` when moving the project. Recreate `node_modules` with `npm.cmd ci`; `dist` and the generated PDF assets are rebuilt by `npm.cmd run build`. No drive-specific source paths are required.

The C-drive copy's `.env.local` survived the move and uses `VITE_BASE_PATH=/`. Do not overwrite it with the example. If it is lost later, copy `.env.example` to `.env.local` and retrieve the URL and publishable key from your existing Supabase project. Keep this file private and out of Git.

At recovery, the local Git repository had no commits or remote and the old drive's project folder was empty. Earlier history could not be restored from that copy. The repaired source is now committed and pushed to [book-storage](https://github.com/hadiabdul123/book-storage); this preserves the current project, not the lost history.

If a future dependency update crashes npm 10 with `Cannot read properties of null (reading 'edgesOut')`, use `npx.cmd --yes npm@11.21.2 install`. This runs npm 11 for that command without replacing the system npm. The repaired lockfile supports ordinary `npm.cmd ci`.

## Configure your private Supabase project

1. Create a free Supabase project dedicated to Leafmark.
2. Run [001_library.sql](supabase/migrations/001_library.sql) in the SQL editor. It creates private-owner access, versioned records, synchronization RPCs, and a private `library` storage bucket.
3. In **Authentication → Users**, create your single email/password user. Do not put the password in any source file.
4. Copy that user’s UUID and run:

   ```sql
   insert into private.owners(user_id) values ('YOUR_AUTH_USER_UUID');
   ```

5. Disable **Allow new users to sign up** in Authentication settings. Use the Supabase dashboard to manage or reset this personal account. No extra email provider is required for normal password sign-in.
6. Copy `.env.example` to `.env.local`; enter your project URL and **publishable key** (legacy anon key also works). For localhost, use `VITE_BASE_PATH=/`.
7. Restart Vite, sign in, and allow the existing local library to synchronize.

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
VITE_BASE_PATH=/
```

Publishable/anon keys are designed for frontend use. **Never use a secret/service-role key, database password, or personal access token in `VITE_*`, source code, or public repository files.** Privacy is enforced by the owner allowlist, RLS, restricted RPCs, and private Storage policies, not by hiding the URL or frontend key.

The shipped CSP supports standard `*.supabase.co` project URLs. A custom Supabase domain requires an explicit CSP update in `index.html`.

Run [security.sql](supabase/tests/security.sql) in the SQL editor to check owner access, rejection of another user, anonymous access, idempotency, and revision conflicts. It creates temporary test users within a transaction and rolls back everything. Separately test Storage with real owner/anonymous sessions; SQL tests do not replace HTTP storage-policy verification.

## GitHub Pages

The repository can be public; private books, notes, and account credentials must never be committed. The Pages app and source are public, while Supabase protects the library.

1. Create a public repository, for example `leafmark-reader`, and push this directory to `main`.
2. In **Settings → Secrets and variables → Actions → Variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. In **Settings → Pages**, choose **GitHub Actions** as the source.
4. Verify owner login and cloud privacy first, then manually run **Check and deploy Leafmark** with **deploy** enabled. Pushes to `main` run checks only. Deployment also requires passing tests and nonempty Supabase repository variables.

The workflow sets the repository base path automatically. Hash routing preserves deep links on static Pages hosting. For a root `username.github.io` repository, change `VITE_BASE_PATH` in the workflow to `/`.

The public source repository does not contain the personal library. Environment files, browser profiles, private test output, book files, and note exports are ignored. Only explicitly named, credited interoperability fixtures are tracked. The initial deployment followed successful live owner sign-in/upload and anonymous API/object denial checks; subsequent deployments remain gated by the test workflow.

## Install and use

### Page notebooks, reading modes, and vocabulary

Selecting text opens a compact toolbar above the passage (below it when there is more room). Click a color to save a highlight immediately. Click a saved highlight, or select any part of it, to change its color; clicking its current color or **Remove highlight** removes the whole annotation. If several highlights overlap, choose which one to change. **Add/Edit note** opens the passage-note editor. Unfinished writing is kept in a private local recovery draft; use **Unfinished notes** to reopen it, or explicitly discard it.

**Meaning** expands the offline dictionary inside the same popup. **Change word** lets you edit the lookup without changing the selected passage. The header Dictionary button still offers a separate manual search. The popup follows scrolling, PDF zoom/rotation, and EPUB/DOCX reflow, and hides while its passage is offscreen.

The header bookmark icon fills when the active PDF page is bookmarked; click it again to remove that page bookmark. EPUB/DOCX use saved reading places, with the visible place nearest the top controlling the icon. **Bookmark passage** in the selection toolbar saves the exact text separately and adds a small clickable bookmark marker. Both kinds appear in Contents. Legacy duplicate bookmarks for a PDF page are removed together when that page is unbookmarked.

Use the reader's **Undo/Redo** buttons or Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y for highlights, attached-note edits, and bookmarks. Text fields and page notebooks keep their normal editing undo. Reader history holds the last 50 actions for the open book and resets when the reader is reopened. Removal also offers a clickable **Undo**, and deleted annotations remain in Trash. Undo refuses to overwrite newer edits from another tab/device or unresolved sync conflicts.

In a PDF, choose **Page notes** or the note button above a page. Each physical PDF page has one formatted notebook with headings, bold/italic text, lists, and checklists. Notes save automatically on this device; the status reports failures. The notebook follows the current page unless you are writing or have unsaved changes. Use **Follow current page** to resume following. Close and reopen the panel without losing saved writing. Search the book's page notes in this panel, or use **Notes → Note type** to search page notes and highlights across books. Tags, trash/restore, Markdown/CSV/JSON export, and existing synchronization also apply to page notes. If both versions of a conflicting page note are kept, they are combined in the same notebook with source labels.

Under **Reading settings**, choose **Pages across** (one or two) independently of **Navigation** (continuous scrolling or paginated). **Fit** controls width or whole-page fit; zoom adjusts that fitted size. Settings persist per PDF. Two-page spreads pair pages 1–2, 3–4, and so on; the last odd page appears alone. A narrow reading area temporarily uses one page without changing your saved preference. In paginated mode, focus the reading area and use Page Up/Down or arrow keys. Region selection exits after a drag; Escape also exits it so normal reading can resume.

Select a word and choose **Meaning**, or open **Dictionary** to type a word. The unfinished highlight is retained while definitions are open. In a PDF, **Add to page note** appends a definition with attribution to that page's notebook. Definitions, parts of speech, synonyms, examples where available, and common inflected forms come from bundled [Open English Wordnet 2025](https://en-word.net/). There is no API key, charge, or online lookup request. It is an English dictionary, not a translation service; some specialist terms and names have no entry.

The dictionary adds about 38 MiB of uncompressed static assets. On a production deployment, stay online until **Reader and dictionary are ready offline** appears before relying on offline lookup, including words never searched before. The committed source archive is checksum-verified and converted locally during preparation; see [dictionary provenance and licenses](vendor/wordnet/README.md). The source and generated chunks are redistributable under their included attribution/license terms.

### Library and offline use

On Android, open the deployed HTTPS URL in Chrome and choose **Install app** or **Add to Home screen**. On Windows, use Chrome/Edge’s install control. Installation and offline cold launch require a successful production build; Vite development mode is not an offline deployment test.

- Add books from the file picker or drag them into the library. Edit metadata, covers, tags, and collection membership through the book’s details menu.
- Open a book to retain a local copy. Book details also offers explicit Download and Remove download actions. The only unsynchronized local copy cannot be removed.
- Select text and click a color to highlight immediately; use **Add note** and **Save note** for an attached note. On scans, enable PDF **Select a region** in reading settings. Selecting text uses native browser handles.
- Open any saved note’s **Go to passage** link to return to the source. EPUB anchors contain CFIs and quoted context; PDF annotations use document coordinates; DOCX anchors use stable offsets into the stored conversion.
- The note archive searches quotes, notes, book titles, and tags and exports Markdown, CSV, and JSON. JSON restore matches the original file hash, preventing anchors from attaching to another edition.
- Trash retains books for recovery. **Delete files** permanently removes original/derived blobs after a synchronized tombstone prevents resurrection. If interrupted, **Retry file cleanup** completes removal. Notes can still be exported.

## Synchronization and offline behavior

Each save commits the entity and its ordered outbox operation in one IndexedDB transaction. A server revision detects concurrent changes; idempotent operation IDs make retries safe. The server serializes each owner’s mutations, so pull cursors follow commit order. A conflicting item stops syncing until you choose a version in Settings; independent items continue. Conflicting highlights can be kept as two separate notes; conflicting page notebooks can be combined into one document.

Positions are exact document locators, with percentage stored only for display. An uncontested cloud position is used when opening a book. Incoming positions never move an actively reading viewport. Concurrent offline positions are preserved for explicit resolution. Synchronization runs while the app is open, on reconnect/focus, and periodically; a closed PWA is not promised background execution.

The service worker caches the application, bundled rendering assets, and public dictionary data. Private books are stored as account-bound IndexedDB blobs. Signed downloads are not placed into a shared service-worker cache. Explicit sign-out removes local private data and is blocked while edits are pending. Offline access assumes a trusted OS/browser profile; this is not encrypted local storage or end-to-end encryption.

There are no application book-count or monthly upload limits. Supabase’s actual storage, database, bandwidth, availability, and per-file limits still apply. Free projects currently cap individual uploads at 50 MB. Failed uploads remain local with a visible sync error; they do not prevent independent annotations from synchronizing. Local space is managed by the browser and can be evicted despite persistence requests.

## Checks

### Private cloud and Android reading

Each book reports local saving, queued upload, upload percentage, upload failure with retry, or confirmed sync. Offline availability is shown separately. Files are retained locally when uploads fail or exceed `VITE_UPLOAD_LIMIT_MB` (50 by default; match your actual Supabase project/bucket limit). Removing a download requires both an uploaded original and acknowledged book metadata, with no pending book change or conflict.

Open a cloud book once to download and retain it for offline reading. Sync runs while the app is open, on reconnection, and when returning to the app; closing Android suspends ongoing work until reopening. Signing out removes the account's local library. Browser storage can still be evicted, so wait for confirmed cloud sync before relying on another device.

Use **Enter reading mode** to hide the toolbars and **Controls** to restore them. PDF zoom is available below the page. PDF layout, zoom, rotation, and device layout overrides stay on this browser; phone defaults are one page, fit width, and continuous scrolling. Notes, bookmarks, and reading position continue to sync. A newly received reading position is offered rather than jumping an active reader automatically.

Before moving an existing local library to GitHub Pages, configure and authenticate the app at its **original PC URL and browser profile** first. Confirm every book has synced, then open the hosted URL on the phone and sign in with the same owner account. IndexedDB is isolated by origin: `localhost`, `127.0.0.1`, and the hosted site have separate libraries. Do not clear the original browser data during migration. GitHub Pages serves only the application; Supabase keeps the private books.

The Pages workflow's deployment gate must stay closed until owner login and database/storage isolation have been verified. A publishable key alone does not initialize the backend: apply `supabase/migrations/001_library.sql` once to the dedicated project, configure the owner account, run `supabase/tests/security.sql`, and verify two authenticated sessions before deployment.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.local\playwright'
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:cloud
npm.cmd run test:pwa
```

The browser suite imports actual upstream EPUB/PDF fixtures and a generated DOCX. It covers saved notes, reloads, typography changes, PDF zoom/rotation, and passage navigation in desktop and Android-sized Chromium contexts. Programmatically constructed browser selections do **not** prove native touch-handle reliability. Follow the physical Android and two-device test matrix in [verification notes](docs/VERIFICATION.md).

`test:cloud` uses two isolated browser contexts and an intercepted Supabase-compatible HTTP/TUS service. It verifies original-byte transfer and hash matching, notes, bookmarks, position restoration, and cached-owner access without an online session. Every external request is intercepted; this checks the client protocol, not the live database's security policies. Run the SQL security checks and authenticated live-device verification separately before enabling deployment.

To check a private PDF without adding it to the repository, set `LEAFMARK_TEST_PDF` to its absolute local path and run `npm.cmd run test:private`. The test blocks external requests, uses an isolated browser, and keeps screenshots under ignored `.local/private-test-results`. Never copy private books into `tests/fixtures`.

`test:pwa` builds a separate local-device application in `.local/pwa-test-dist` and serves it on port 4174. It saves a PDF highlight and note, clears the ordinary HTTP cache, closes Chromium, and restarts it offline with the same profile. It checks the saved passage, a formatted page notebook, a previously unseen dictionary word, and cached PDF worker, fonts, character maps, and WebAssembly assets. The test uses a short temporary profile path under `.local` to avoid Windows path-length limits. This verifies desktop browser offline restart; installation on an actual phone and authenticated offline recovery still need device testing.

## Project structure

- `src/reader/`: format adapters; shared reader interface; no cloud concerns.
- `src/db.ts`, `src/sync.ts`, `src/model.ts`: durable local state, ordered sync, shared versioned types.
- `src/Library.tsx`, `src/Reader.tsx`, `src/Notes.tsx`, `src/Settings.tsx`: product workflows.
- `supabase/`: schema, authorization, synchronization, and SQL security checks.
- `tests/`: anchor/persistence checks and real-document browser regressions.

## Boundaries

DOCX is a semantic reading conversion, not a Word layout renderer. PDFs retain fixed typography. Scans support regions without OCR. DRM-protected ebooks, encrypted PDFs, scripted EPUB content, TTS, social reading, and third-party integrations are outside this version. Very large files remain subject to device memory and provider constraints. Fixed-layout/RTL EPUBs and complex multi-column PDF selections need further fixture coverage before broad compatibility can be claimed.

## References and credits

Product research: [BookFusion](https://www.bookfusion.com), [Android listing](https://play.google.com/store/apps/details?id=com.bookfusion.android.reader), [features](https://www.bookfusion.com/features), [highlights](https://www.bookfusion.com/reading/highlights), [apps and sync](https://www.bookfusion.com/reading/apps), [documentation](https://docs.bookfusion.com/docs/). Text references were reviewed; screenshot inspection was blocked in the development environment. No BookFusion branding, artwork, or proprietary code is included.

Rendering: [EPUB.js](https://github.com/futurepress/epub.js), [Mozilla PDF.js](https://github.com/mozilla/pdf.js), [Mammoth](https://github.com/mwilliamson/mammoth.js), and [DOMPurify](https://github.com/cure53/DOMPurify). Fonts: Literata and Source Sans 3. Icons: Lucide. Preserve their licenses in distributions. Test document sources are listed in [fixture credits](tests/fixtures/SOURCES.md).
