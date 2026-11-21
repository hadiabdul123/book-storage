import { beforeEach, expect, it, vi } from "vitest";
import { createResearchHandler, validResearchInput, providerFailure } from "../supabase/functions/research/handler";
const source = { id: "selection", kind: "book", title: "Cosmology", excerpt: "Private surrounding passage about an expanding universe.", bookId: "book", locator: { v: 1, type: "pdf", hash: "a".repeat(64), page: 1, y: 0 } };
const input = () => ({ requestId: crypto.randomUUID(), mode: "web", question: "What evidence supports the Big Bang?", searchQuery: "Big Bang evidence", sources: [source], history: [] });
const deps = () => ({ authenticate: vi.fn(async () => "owner" as string | null), reserve: vi.fn(async () => ({ state: "new" as const })), finish: vi.fn(async () => {}), groqKey: "private-groq-key", tavilyKey: "private-tavily-key", allowedOrigins: ["https://reader.example"], fetcher: vi.fn<typeof fetch>() });
function request(data: unknown = input(), headers: Record<string, string> = {}) { return new Request("https://backend.example/research", { method: "POST", headers: { Authorization: "Bearer owner-token", Origin: "https://reader.example", ...headers }, body: JSON.stringify(data) }); }
let d: ReturnType<typeof deps>;
beforeEach(() => { d = deps(); });
it("defines short phrases using general language knowledge without pretending examples are book citations", async () => {
  const meaning = { definition: "A feeling of ease.", context: "Here it describes a peaceful room.", examples: ["The chair offers comfort.", "Her words brought comfort.", "I value comfort at home."], usage: "Comfort can be a noun or a verb." };
  d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(meaning) } }] }));
  const r = await createResearchHandler(d)(request({ ...input(), mode: "explain", meaning: { term: "comfort" }, sources: [] }));
  expect(r.status).toBe(200); const body = await r.json();
  expect(body.sources).toEqual([]); expect(body.answer).toContain("3. I value comfort"); expect(body.answer).not.toContain("[S1]");
  const sent = JSON.parse(d.fetcher.mock.calls[0][1]!.body as string);
  expect(sent.messages[0].content).toContain("general language knowledge");
  expect(sent.response_format.json_schema.strict).toBe(true); expect(d.fetcher).toHaveBeenCalledOnce();
});
it("rejects invalid meaning requests and incomplete AI examples without changing ordinary research validation", async () => {
  expect(validResearchInput({ ...input(), meaning: { term: "word" } })).toBe(false);
  expect(validResearchInput({ ...input(), mode: "explain", meaning: { term: "x".repeat(101) } })).toBe(false);
  expect(validResearchInput({ ...input(), mode: "explain", meaning: null })).toBe(false);
  d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ definition: "Meaning", context: "Here", examples: ["One"], usage: "Usage" }) } }] }));
  const r = await createResearchHandler(d)(request({ ...input(), mode: "explain", meaning: { term: "word" } }));
  expect(r.status).toBe(502); expect((await r.json()).code).toBe("format");
});
it("keeps a geometry-heavy PDF citation intact while sending the model only the evidence text", async () => {
  const rects = Array.from({ length: 260 }, (_, i) => [40.1234567890123 + i / 3, 120.9876543210123 + i / 7, 52.1234567890123 + i / 3, 135.9876543210123 + i / 7]);
  const selected = { ...source, locator: { ...source.locator, regions: [{ page: 1, rects }], quote: { exact: "A selected passage", prefix: "", suffix: "" } } };
  d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ paragraphs: [{ text: "This explains the passage.", sourceId: "S1", additionalSourceIds: [] }] }) } }] }));
  const r = await createResearchHandler(d)(request({ ...input(), mode: "explain", sources: [selected] }));
  expect(r.status).toBe(200);
  const providerRequest = JSON.parse(d.fetcher.mock.calls[0][1]!.body as string);
  const evidence = JSON.parse(providerRequest.messages[1].content).sources;
  expect(evidence).toEqual([{ id: "S1", kind: "book", title: source.title, excerpt: source.excerpt }]);
  expect(JSON.stringify(providerRequest)).not.toContain("regions");
  expect(JSON.stringify(providerRequest).length).toBeLessThan(3000);
  expect(providerRequest.response_format.json_schema).toMatchObject({ strict: true, schema: { required: ["paragraphs"], additionalProperties: false } });
  const result = await r.json();
  expect(result.sources[0].locator).toEqual(selected.locator);
  expect(result.answer).toBe("This explains the passage. [S1]");
});
it("reports provider context, key, model, quota, and formatting failures without exposing raw provider text", () => {
  expect(providerFailure("groq", 413, { error: { message: "private request body" } }).code).toBe("context");
  expect(providerFailure("groq", 400, { error: { code: "json_validate_failed", message: "private generated text" } }).code).toBe("format");
  expect(providerFailure("groq", 401, {}).code).toBe("configuration");
  expect(providerFailure("groq", 404, {}).code).toBe("configuration");
  expect(providerFailure("groq", 429, {}, 120).retryAfter).toBe(120);
  expect(providerFailure("groq", 400, { error: { message: "private generated text" } }).message).not.toContain("private generated text");
});
it("uses one basic web search, excludes private passage text from search, and returns real source metadata", async () => {
  d.fetcher.mockResolvedValueOnce(Response.json({ results: [{ title: "NASA cosmology", url: "https://science.nasa.gov/universe/", content: "The universe is expanding." }] }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ paragraphs: [{ text: "Expansion is evidence. The book discusses it.", sourceId: "S2", additionalSourceIds: ["S1"] }] }) } }] }));
  const r = await createResearchHandler(d)(request()); const body = await r.json();
  expect(r.status).toBe(200); expect(d.fetcher).toHaveBeenCalledTimes(2);
  const search = JSON.parse(d.fetcher.mock.calls[0][1]!.body as string);
  expect(search).toMatchObject({ query: "Big Bang evidence", search_depth: "basic", max_results: 5, auto_parameters: false });
  expect(JSON.stringify(search)).not.toContain("Private surrounding");
  expect(body.sources[1]).toMatchObject({ id: "S2", kind: "web", url: "https://science.nasa.gov/universe/" });
  expect(body.sources[1].retrievedAt).toBeTruthy();
  expect(JSON.stringify(body)).not.toContain("private-groq-key"); expect(d.finish).toHaveBeenCalledWith("Bearer owner-token", expect.any(String), body);
});
it("rejects missing or unauthorized authentication before invoking providers", async () => {
  expect((await createResearchHandler(d)(request(input(), { Authorization: "" }))).status).toBe(401);
  d.authenticate.mockResolvedValue(null);
  expect((await createResearchHandler(d)(request())).status).toBe(401); expect(d.fetcher).not.toHaveBeenCalled();
});
it("rejects unknown origins and malformed or oversized source payloads", async () => {
  expect((await createResearchHandler(d)(request(input(), { Origin: "https://unknown.example" }))).status).toBe(403);
  expect((await createResearchHandler(d)(request({ ...input(), sources: [{ ...source, excerpt: "x".repeat(2500) }] }))).status).toBe(400);
  expect((await createResearchHandler(d)(request({ ...input(), question: "x".repeat(65000) }))).status).toBe(413);
  expect(d.fetcher).not.toHaveBeenCalled();
});
it("does not call a model when a chosen-library question has no evidence", async () => {
  const r = await createResearchHandler(d)(request({ ...input(), mode: "sources", sources: [] }));
  expect(r.status).toBe(200); expect((await r.json()).answer).toContain("supporting sources"); expect(d.fetcher).not.toHaveBeenCalled();
});
it("refuses invented source IDs and answers without a structured source reference", async () => {
  for (const sourceId of ["S9", ""]) {
    d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ paragraphs: [{ text: "A confident answer.", sourceId, additionalSourceIds: [] }] }) } }] }));
    const r = await createResearchHandler(d)(request({ ...input(), mode: "explain" }));
    expect(r.status).toBe(502); expect((await r.json()).code).toBe("citations");
  }
});
it("replays a finished request without consuming provider quota", async () => {
  const result = { answer: "Saved [S1]", sources: [{ ...source, id: "S1" }], model: "test" };
  d.reserve.mockResolvedValue({ state: "cached", result } as any);
  const r = await createResearchHandler(d)(request()); expect(await r.json()).toEqual(result); expect(d.fetcher).not.toHaveBeenCalled();
});
it("stops at quota errors and preserves provider retry delays", async () => {
  d.fetcher.mockResolvedValueOnce(new Response("private provider detail", { status: 429, headers: { "Retry-After": "120" } }));
  const r = await createResearchHandler(d)(request());
  expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("120"); expect(await r.text()).not.toContain("private provider detail"); expect(d.fetcher).toHaveBeenCalledTimes(1);
});
it("reports missing configuration and exposes only readiness booleans to the owner", async () => {
  d.tavilyKey = "";
  expect((await createResearchHandler(d)(request())).status).toBe(503);
  const r = await createResearchHandler(d)(new Request("https://backend.example/research", { headers: { Authorization: "Bearer owner-token" } }));
  expect(await r.json()).toEqual({ groq: true, tavily: false }); expect(d.fetcher).not.toHaveBeenCalled();
});
it("validates source locators and the bounded history contract", () => {
  expect(validResearchInput(input())).toBe(true);
  expect(validResearchInput({ ...input(), sources: [{ ...source, locator: { type: "pdf", hash: "bad" } }] })).toBe(false);
  expect(validResearchInput({ ...input(), history: Array(5).fill({ question: "Q", answer: "A" }) })).toBe(false);
});

it("builds a cited book comparison with an explicit gap for books with no matching text", async () => {
  const books = [{ bookId: "book", title: "Cosmology" }, { bookId: "empty", title: "Other book" }];
  const generated = {
    columns: [{ bookId: "book", answer: "The book discusses expansion.", gap: "", sourceIds: ["S1"] }],
    synthesis: { text: "Only one book supplied relevant evidence.", sourceIds: ["S1"] },
  };
  d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] }));
  const response = await createResearchHandler(d)(request({ ...input(), mode: "sources", comparison: { books } }));
  expect(response.status).toBe(200);
  const output = await response.json();
  expect(output.comparison.columns).toMatchObject([{ ...books[0], ...generated.columns[0] }, { ...books[1], answer: "", sourceIds: [] }]);
  expect(output.comparison.columns[1].gap).toContain("No relevant text");
  expect(output.answer).toContain("[S1]");
  expect(output.sources[0].locator).toEqual(source.locator);
  expect(d.fetcher).toHaveBeenCalledOnce();
});

it("rejects comparison citations that point to another book", async () => {
  const books = [{ bookId: "book", title: "Cosmology" }, { bookId: "other", title: "Other book" }];
  const generated = {
    columns: books.map(book => ({ bookId: book.bookId, answer: "An answer.", gap: "", sourceIds: ["S1"] })),
    synthesis: { text: "Compared.", sourceIds: ["S1"] },
  };
  d.fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] }));
  const response = await createResearchHandler(d)(request({ ...input(), mode: "sources", comparison: { books },
    sources: [source, { ...source, bookId: "other" }] }));
  expect(response.status).toBe(502);
  expect((await response.json()).code).toBe("citations");
});

it("compares a page and notebook entry and rejects citations assigned to the wrong source", async () => {
  const note = { id:"note1",kind:"note",noteId:"monday",title:"Monday",excerpt:"This idea appeared in my notes." };
  const books = [{ bookId:"book",title:"Cosmology" },{ bookId:"note:monday",title:"Monday" }];
  const payload = { ...input(),mode:"sources",comparison:{ books },sources:[source,note] };
  for (const misattributed of [false,true]) {
    const columns = books.map((b,i) => ({ ...b,answer:"An observation.",gap:"",sourceIds:[i === 1 && misattributed ? "S1" : "S" + (i+1)] }));
    const content = JSON.stringify({ columns,synthesis:{text:"Their observations differ.",sourceIds:["S1","S2"]} });
    d.fetcher.mockResolvedValueOnce(Response.json({choices:[{message:{content}}]}));
    const response = await createResearchHandler(d)(request(payload));
    expect(response.status).toBe(misattributed ? 502 : 200);
  }
});

it.each(["Earth", "NONE"])("streams a useful definition ahead of later tokens and saves the finished result (%s)", async topic => {
  let provider!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({start(out) { provider = out; }});
  const push = (content:string) => provider.enqueue(new TextEncoder().encode("data: " + JSON.stringify({choices:[{delta:{content}}]}) + "\r\n"));
  d.fetcher.mockResolvedValueOnce(new Response(body));
  const response = await createResearchHandler(d)(request({...input(),mode:"explain",meaning:{term:"earth"}}, {Accept:"application/x-ndjson"}));
  expect(response.headers.get("content-type")).toContain("ndjson");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  push("Definition: Our home planet.\n");
  expect(JSON.parse(decoder.decode((await reader.read()).value)).text).toBe("Definition\nOur home planet.");
  expect(d.finish).not.toHaveBeenCalled();
  push("Context: The third planet.\nExample: A.\nExample: B.\nExample: C.\nUsage: Capitalize Earth.\nVisual: "+topic);
  provider.close();
  let rest = "";
  for (;;) { const {value,done} = await reader.read(); if (done) break; rest += decoder.decode(value); }
  const result = JSON.parse(rest.trim().split("\n").at(-1)!).result;
  expect(result.answer).toContain("3. C."); expect(result.answer).not.toContain("Visual:");
  expect(result.visualQuery).toBe(topic === "Earth" ? topic : undefined);
  expect(d.finish).toHaveBeenCalledOnce(); expect(d.fetcher).toHaveBeenCalledOnce();
});
