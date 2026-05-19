import { Router, Request, Response } from "express";
import { supabase, supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة" });
    return;
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name_ar, tenant_id")
    .eq("id", data.user.id)
    .single();

  res.json({
    token:        data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at:   data.session.expires_at,
    user: {
      id:           data.user.id,
      email:        data.user.email,
      role:         profile?.role ?? "staff",
      full_name_ar: profile?.full_name_ar,
      tenant_id:    profile?.tenant_id,
    },
  });
});

// POST /api/auth/logout
router.post("/logout", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabase.auth.signOut();
  res.json({ message: "تم تسجيل الخروج بنجاح" });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name_ar, full_name, tenant_id, tenants(name, name_ar, plan)")
    .eq("id", req.user!.id)
    .single();

  res.json({
    id:    req.user!.id,
    email: req.user!.email,
    ...profile,
  });
});

// POST /api/auth/refresh
router.post("/refresh", async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) { res.status(400).json({ error: "refresh_token مطلوب" }); return; }

  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error || !data.session) { res.status(401).json({ error: "انتهت الجلسة" }); return; }

  res.json({
    token:        data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at:   data.session.expires_at,
  });
});

export default router;
