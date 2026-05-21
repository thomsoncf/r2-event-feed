import { Hono } from "hono";
import { accessMiddleware } from "./middleware/access";
import { auditMiddleware } from "./middleware/audit";
import adminRoutes from "./routes/admin";
import enrolRoutes from "./routes/enrol";
import streamRoutes from "./routes/streams";
import tokenRoutes from "./routes/tokens";
import webhookRoutes from "./routes/webhooks";
import type { Env, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "feed-portal" }));

// Everything under /api requires an authenticated user.
app.use("/api/*", accessMiddleware(), auditMiddleware());

app.route("/", enrolRoutes);
app.route("/", tokenRoutes);
app.route("/", webhookRoutes);
app.route("/", streamRoutes);
app.route("/", adminRoutes);

app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));
app.onError((err, c) => {
	console.error("portal error", err);
	return c.json({ error: "internal", message: err.message }, 500);
});

export default app;
