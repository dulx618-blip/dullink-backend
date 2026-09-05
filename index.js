import { Hono } from "hono";
import { neon, types } from "@neondatabase/serverless";
import { auth } from "./auth";
import { ai } from "./ai";

types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));
types.setTypeParser(types.builtins.DATE, (value) => value);

const app = new Hono();
const OWNER_EMAIL = "dulx618@gmail.com";

type Role = "owner" | "moderator" | "member" | "guest";

async function getAccess(c: any) {
 const user = auth(c).user();
 if (!user) return { user, role: "guest" as Role };
 const email = (user.email || "").toLowerCase();
 if (email === OWNER_EMAIL) return { user, role: "owner" as Role };

 const sql = neon(c.env.DATABASE_URL);
 const rows =
 await sql`SELECT email FROM moderators WHERE LOWER(email) = ${email} AND active = TRUE LIMIT 1`;
 return {
 user,
 role: rows.length ? ("moderator" as Role) : ("member" as Role),
 };
}

function clean(value: unknown) {
 return typeof value === "string" ? value.trim() : "";
}

app.get("/app-api/bootstrap", async (c) => {
 const access = await getAccess(c);
 const sql = neon(c.env.DATABASE_URL);
 const settings =
 await sql`SELECT ai_mode FROM app_settings ORDER BY id ASC LIMIT 1`;
 return c.json({
 role: access.role,
 aiMode: settings[0]?.ai_mode ?? "active",
 ownerEmail: OWNER_EMAIL,
 });
});

app.get("/app-api/home-summary", async (c) => {
 const sql = neon(c.env.DATABASE_URL);
 const rows = await sql`SELECT * FROM dullink_home_summary LIMIT 1`;
 return c.json(
 rows[0] ?? { open_jobs: 0, approved_candidates: 0, insurance_pct: 5 },
 );
});

app.get("/app-api/jobs", async (c) => {
 const query = clean(c.req.query("q"));
 const region = clean(c.req.query("region"));
 const sql = neon(c.env.DATABASE_URL);
 const search = `%${query}%`;
 const regionSearch = `%${region}%`;
 const rows =
 query && region
 ? await sql`SELECT * FROM jobs WHERE status <> 'Cubierta' AND (title ILIKE ${search} OR company ILIKE ${search}) AND location ILIKE ${regionSearch} ORDER BY created_at DESC, id DESC`
 : query
 ? await sql`SELECT * FROM jobs WHERE status <> 'Cubierta' AND (title ILIKE ${search} OR company ILIKE ${search}) ORDER BY created_at DESC, id DESC`
 : region
 ? await sql`SELECT * FROM jobs WHERE status <> 'Cubierta' AND location ILIKE ${regionSearch} ORDER BY created_at DESC, id DESC`
 : await sql`SELECT * FROM jobs WHERE status <> 'Cubierta' ORDER BY created_at DESC, id DESC`;
 return c.json(rows);
});

app.get("/app-api/candidates", async (c) => {
 const sql = neon(c.env.DATABASE_URL);
 const rows =
 await sql`SELECT id, name, role, region, language, experience_years, insurance_optin FROM candidates WHERE approval_status = 'Aprobado' ORDER BY updated_at DESC, id DESC LIMIT 30`;
 return c.json(rows);
});

app.post("/app-api/interviews", async (c) => {
 const body = await c.req.json();
 const name = clean(body.name);
 const email = clean(body.email);
 const role = clean(body.role);
 const region = clean(body.region);
 const language = clean(body.language);
 const studies = clean(body.studies);
 const skills = clean(body.skills);
 const previousJobs = clean(body.previousJobs);
 const insuranceOptin = body.insuranceOptin === true;
 if (
 !name ||
 !email ||
 !role ||
 !region ||
 !language ||
 !studies ||
 !skills ||
 !previousJobs
 ) {
 return c.json(
 { message: "Completa todos los campos de la entrevista." },
 400,
 );
 }

 const access = await getAccess(c);
 const sql = neon(c.env.DATABASE_URL);
 const [candidate] =
 await sql`INSERT INTO candidates (name, role, region, language, experience_years, approval_status, interview_status, insurance_optin, studies, skills, previous_jobs, created_by) VALUES (${name}, ${role}, ${region}, ${language}, 0, 'Pendiente', 'En revisión', ${insuranceOptin}, ${studies}, ${skills}, ${previousJobs}, ${access.user?.id ?? null}) RETURNING *`;
 const answers = {
 email,
 studies,
 skills,
 previousJobs,
 region,
 language,
 insuranceOptin,
 };
 const [interview] =
 await sql`INSERT INTO interviews (candidate_id, studies, skills, previous_jobs, answers, status) VALUES (${candidate.id}, ${studies}, ${skills}, ${previousJobs}, ${JSON.stringify(answers)}::jsonb, 'Pendiente') RETURNING *`;
 const settings =
 await sql`SELECT ai_mode FROM app_settings ORDER BY id ASC LIMIT 1`;
 const aiMode = settings[0]?.ai_mode ?? "active";
 let instruction =
 "Tu perfil está en revisión. El equipo de Dullink validará tus respuestas y te contactará cuando haya una coincidencia.";
 let responseMode = aiMode;

 if (aiMode === "manual") {
 await sql`INSERT INTO messages (sender_name, sender_email, body, thread_type, status) VALUES (${name}, ${email}, ${"Nueva entrevista recibida. El perfil necesita revisión manual."}, 'candidate', 'Nuevo')`;
 } else {
 try {
 const result = await ai(c.env).complete({
 model: "anthropic/claude-sonnet-4-6",
 system:
 "Eres el asistente de revisión de Dullink. Responde en español, con tono breve, claro y cordial. Indica que el perfil está en revisión y da dos instrucciones concretas: revisar el correo y mantener actualizadas sus habilidades. No prometas contratación ni garantías.",
 messages: [
 {
 role: "user",
 content: `Candidato: ${name}. Puesto: ${role}. Región: ${region}. Estudios: ${studies}. Habilidades: ${skills}. Experiencia previa: ${previousJobs}.`,
 },
 ],
 maxTokens: 180,
 });
 instruction = result.text || instruction;
 } catch (error) {
 responseMode = "manual";
 await sql`INSERT INTO messages (sender_name, sender_email, body, thread_type, status) VALUES (${name}, ${email}, ${"La IA no está disponible. Revisar entrevista y responder manualmente."}, 'candidate', 'Nuevo')`;
 }
 }

 return c.json({ candidate, interview, instruction, mode: responseMode }, 201);
});

app.post("/app-api/company-requests", async (c) => {
 const body = await c.req.json();
 const companyName = clean(body.companyName);
 const contactEmail = clean(body.contactEmail);
 const location = clean(body.location);
 const requirements = clean(body.requirements);
 const preferences = clean(body.preferences);
 if (!companyName || !contactEmail || !location || !requirements) {
 return c.json(
 { message: "Completa el nombre, correo, ubicación y requisitos." },
 400,
 );
 }
 const sql = neon(c.env.DATABASE_URL);
 const [request] =
 await sql`INSERT INTO company_requests (company_name, contact_email, location, requirements, preferences, plan) VALUES (${companyName}, ${contactEmail}, ${location}, ${requirements}, ${preferences}, 'Premium $7/mes') RETURNING *`;
 return c.json(request, 201);
});

app.get("/app-api/admin/reviews", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner" && access.role !== "moderator")
 return c.json({ allowed: false, rows: [] });
 const sql = neon(c.env.DATABASE_URL);
 const rows =
 await sql`SELECT * FROM dullink_review_queue WHERE review_status = 'Pendiente' OR approval_status <> 'Aprobado' ORDER BY created_at DESC LIMIT 50`;
 return c.json({ allowed: true, rows });
});

app.patch("/app-api/admin/reviews/:id", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner" && access.role !== "moderator")
 return c.json({ ok: false, message: "Esta acción no está disponible." });
 const body = await c.req.json();
 const status =
 body.status === "Aprobada"
 ? "Aprobada"
 : body.status === "Rechazada"
 ? "Rechazada"
 : "Pendiente";
 const approval =
 status === "Aprobada"
 ? "Aprobado"
 : status === "Rechazada"
 ? "Rechazado"
 : "Pendiente";
 const id = c.req.param("id");
 const sql = neon(c.env.DATABASE_URL);
 const [review] =
 await sql`UPDATE interviews SET status = ${status}, reviewed_by = ${access.user?.email ?? null}, reviewed_at = NOW(), updated_at = NOW() WHERE id = ${id} RETURNING *`;
 if (review)
 await sql`UPDATE candidates SET approval_status = ${approval}, interview_status = ${status}, updated_at = NOW() WHERE id = ${review.candidate_id}`;
 return c.json({ ok: Boolean(review), review });
});

app.get("/app-api/admin/messages", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner" && access.role !== "moderator")
 return c.json({ allowed: false, rows: [] });
 const sql = neon(c.env.DATABASE_URL);
 const rows =
 await sql`SELECT * FROM messages ORDER BY created_at DESC LIMIT 60`;
 return c.json({ allowed: true, rows });
});

app.post("/app-api/admin/messages/:id/reply", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner" && access.role !== "moderator")
 return c.json({ ok: false, message: "Esta acción no está disponible." });
 const body = await c.req.json();
 const reply = clean(body.body);
 if (!reply)
 return c.json({ ok: false, message: "Escribe una respuesta." }, 400);
 const id = c.req.param("id");
 const sql = neon(c.env.DATABASE_URL);
 const originals =
 await sql`SELECT sender_name, sender_email FROM messages WHERE id = ${id} LIMIT 1`;
 const original = originals[0];
 if (!original)
 return c.json({ ok: false, message: "Mensaje no encontrado." });
 const [message] =
 await sql`INSERT INTO messages (sender_name, sender_email, body, thread_type, status, assigned_to) VALUES (${"Dullink"}, ${original.sender_email}, ${reply}, 'admin', 'Respondido', ${access.user?.email ?? null}) RETURNING *`;
 await sql`UPDATE messages SET status = 'Respondido', updated_at = NOW(), assigned_to = ${access.user?.email ?? null} WHERE id = ${id}`;
 return c.json({ ok: true, message });
});

app.patch("/app-api/admin/settings", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner")
 return c.json({
 ok: false,
 message: "Solo el dueño puede cambiar el modo operativo.",
 });
 const body = await c.req.json();
 const aiMode = body.aiMode === "manual" ? "manual" : "active";
 const sql = neon(c.env.DATABASE_URL);
 const [settings] =
 await sql`UPDATE app_settings SET ai_mode = ${aiMode}, updated_by = ${access.user?.email ?? null}, updated_at = NOW() WHERE id = (SELECT id FROM app_settings ORDER BY id ASC LIMIT 1) RETURNING *`;
 return c.json({ ok: true, settings });
});

app.get("/app-api/admin/moderators", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner") return c.json({ allowed: false, rows: [] });
 const sql = neon(c.env.DATABASE_URL);
 const rows =
 await sql`SELECT id, name, email, can_chat, can_approve, active, created_at FROM moderators ORDER BY active DESC, created_at DESC`;
 return c.json({ allowed: true, rows });
});

app.post("/app-api/admin/moderators", async (c) => {
 const access = await getAccess(c);
 if (access.role !== "owner")
 return c.json({
 ok: false,
 message: "Solo el dueño puede crear moderadores.",
 });
 const body = await c.req.json();
 const name = clean(body.name);
 const email = clean(body.email).toLowerCase();
 if (!name || !email)
 return c.json(
 { ok: fals
