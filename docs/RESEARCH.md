# Research and connected notebooks

Select a word, phrase, or paragraph in a PDF, EPUB, or DOCX and choose **Research**. **Meaning → Explain in this passage** opens the same workspace. The reader toolbar also has **Research book** for questions without an active selection.

- **Explain** uses the selected passage and nearby text to explain the meaning in context.
- **My sources** lets you select downloaded books and topic notes. Local text indexing retrieves relevant excerpts; the complete library is not uploaded. Reader notes from chosen books are also included when relevant. Scans use already cached OCR and report incomplete text coverage.
- **Web** sends the visible public search query to Tavily, then asks Groq to explain the results alongside any selected passage. Edit the public query for follow-up searches. Each question performs at most one basic search with up to five results.

Answers include source references. Tap an inline reference to expand its evidence. Book references return to the saved page or passage; external references open their original URL. Evidence excerpts remain saved with the conversation.

Select the part of an answer you want to keep, then choose **Save selected excerpt…**. Without a text selection, **Save answer…** saves the full answer. Choose a passage note, a PDF page notebook, an existing topic note, or a new topic note. Source references travel with the saved excerpt. **Copy** uses the clipboard.

## Topic notebooks

Open **Notebooks & research** from the desktop navigation or **Notebooks** on a phone. Create a notebook and notes with headings, bold, italic, lists, and checklists. Notes save locally automatically, retain recovery drafts, and synchronize through the existing private library. Research opened beside a topic note includes that note in the source picker.

Connected-source links appear below a note. Concurrent note versions received from another device are retained locally for recovery (up to 50 versions per note). Recover a version as a separate note so it does not overwrite current writing. Trash and restore are in Settings.

Export notebooks and research as Markdown or a versioned JSON backup. Restore validates the whole backup before writing and keeps existing records. Book citations are remapped by the original file hash. A missing original source retains its excerpt and citation rather than attaching to another edition. Annotation JSON version 3 includes citations and still accepts versions 1 and 2.

## Offline behavior

After an owner has signed in on a device, downloaded books and writing remain accessible when the connection fails or a saved session expires. First-time authorization still needs a connection. A different cached account or an explicit server owner denial cannot use the offline fallback.

Settings → **Offline storage** shows reader installation and book download readiness. Keep the hosted app online until reader tools finish installing, and open/download each book before leaving the connection. Browser-managed storage can still be removed by the device; exports and cloud copies remain important.

Offline questions keep the selected context and wait in a durable queue. They resume sequentially while Leafmark is open and connected. Provider quota, missing configuration, and authentication failures pause questions with a visible retry action. Cancelled requests never append a late answer. Saved answers remain readable offline; web results reused online expire after 24 hours unless refreshed. No cloud answer automatically rewrites a note.

## Backend setup and free allowances

Apply `20261115190452_reader_research_notebooks.sql` before deploying the frontend. Deploy the `research` Edge Function with `verify_jwt=false`: the handler validates the bearer token with Supabase Auth and checks `is_library_owner` itself. Anonymous and unapproved accounts are rejected. Keys are never bundled into frontend code.

Set these Edge Function secrets:

```dotenv
GROQ_API_KEY=your-free-groq-key
TAVILY_API_KEY=your-free-tavily-key
RESEARCH_MODEL=openai/gpt-oss-20b
RESEARCH_ALLOWED_ORIGINS=https://hadiabdul123.github.io,http://127.0.0.1:5173
```

Keep provider accounts on their free plans; this app cannot control billing enabled separately in a provider account. The app adds guards of 20 research attempts per 10 minutes and 900 web attempts per calendar month, below Tavily's documented 1,000-credit monthly free allowance. Provider limits can be lower and apply across other applications using the same account. No automatic model/provider upgrade is performed.

Use Settings → **Check research connection** to verify that both secrets are configured. This check does not consume model or search quota. Send an actual question to verify provider account eligibility and remaining allowance. Backend request replay avoids repeating a successfully completed request after a connection interruption. Request receipts expire after 30 days; local saved conversations are retained.

## Checks

`npm test`, `npm run build`, `npm run test:e2e`, `npm run test:cloud`, `npm run test:pwa`, and `npm run test:pwa:cloud` cover source/citation handling, notebook recovery, backend provider orchestration, privacy, auth fallback, and production offline restart. Browser cloud tests use synthetic transports; they do not establish live provider quality or physical Android behavior.

Run `supabase/tests/research.sql`, `security.sql`, and `latest_change.sql` after the migration. They exercise synthetic records in transactions and roll back all data. Final device verification is: install/update → sign in → download → close → airplane mode → reopen → read and write → queue research → reconnect → confirm synchronization and the answer.
