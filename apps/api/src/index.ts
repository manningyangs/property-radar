import { Hono } from "hono";

// API 骨架：完整路由（auth/rules/coverage/history/admin）按 TASK-02B/03 实施
const app = new Hono();

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    service: "property-radar-api",
    time: new Date().toISOString(),
  }),
);

app.notFound((c) => c.json({ error: "not_found", code: 404 }, 404));

app.onError((err, c) => {
  console.error("unhandled_error", err);
  return c.json({ error: "internal_error", code: 500 }, 500);
});

export default app;
