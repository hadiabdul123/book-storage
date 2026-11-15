import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { createResearchHandler } from "./handler.ts";

const client = (authorization: string) => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(createResearchHandler({
  groqKey: Deno.env.get("GROQ_API_KEY"), tavilyKey: Deno.env.get("TAVILY_API_KEY"), model: Deno.env.get("RESEARCH_MODEL") || "openai/gpt-oss-20b",
  allowedOrigins: (Deno.env.get("RESEARCH_ALLOWED_ORIGINS") || "https://hadiabdul123.github.io,http://127.0.0.1:5173,http://127.0.0.1:4173,http://localhost:5173").split(",").map(s => s.trim()),
  authenticate: async authorization => {
    const c = client(authorization);
    const { data: { user }, error } = await c.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (error || !user) return null;
    const { data, error: denied } = await c.rpc("is_library_owner");
    return !denied && data === true ? user.id : null;
  },
  reserve: async (authorization, id, mode) => {
    const { data, error } = await client(authorization).rpc("research_begin", { p_id: id, p_mode: mode });
    if (error) throw new Error("Research backend is unavailable");
    return data;
  },
  finish: async (authorization, id, result) => {
    const { error } = await client(authorization).rpc("research_finish", { p_id: id, p_result: result || null });
    if (error) throw new Error("Could not retain research result");
  },
}));
