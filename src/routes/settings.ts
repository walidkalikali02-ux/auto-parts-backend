import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { sendEmail, inviteHtml } from "../lib/email.js";

const router = Router();

// GET /api/settings — get current tenant settings
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("tenant_id")
    .eq("id", req.user!.id)
    .single();

  if (!profile?.tenant_id) return res.status(400).json({ error: "لا يوجد مستأجر" });

  const { data: tenant, error } = await supabaseAdmin
    .from("tenants")
    .select("*")
    .eq("id", profile.tenant_id)
    .single();

  if (error) return res.status(404).json({ error: "المستأجر غير موجود" });

  // Usage stats
  const [partsCount, usersCount, ordersThisMonth] = await Promise.all([
    supabaseAdmin.from("parts").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", profile.tenant_id),
    supabaseAdmin.from("sales_orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", profile.tenant_id)
      .gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ]);

  res.json({
    ...tenant,
    usage: {
      parts:        partsCount.count ?? 0,
      users:        usersCount.count ?? 0,
      orders_month: ordersThisMonth.count ?? 0,
    },
  });
});

// PUT /api/settings — update tenant settings
router.put("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("tenant_id, role")
    .eq("id", req.user!.id)
    .single();

  if (!profile?.tenant_id) return res.status(400).json({ error: "لا يوجد مستأجر" });
  if (!["admin", "superadmin"].includes(profile.role ?? "")) {
    return res.status(403).json({ error: "غير مصرح لك بتعديل الإعدادات" });
  }

  const allowed = ["name", "name_ar", "logo_url", "vat_number", "address", "city", "country", "phone", "email", "website", "currency", "settings"];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .update(updates)
    .eq("id", profile.tenant_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/settings/invite — invite a user to the tenant
router.post("/invite", requireAuth, async (req: AuthRequest, res: Response) => {
  const { email, role = "staff" } = req.body;
  if (!email) return res.status(400).json({ error: "البريد الإلكتروني مطلوب" });

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("tenant_id, role")
    .eq("id", req.user!.id)
    .single();

  if (!["admin", "superadmin"].includes(profile?.role ?? "")) {
    return res.status(403).json({ error: "غير مصرح لك بإرسال دعوات" });
  }

  // Check user limit
  const { data: tenant } = await supabaseAdmin.from("tenants").select("name_ar,max_users").eq("id", profile!.tenant_id).single();
  const { count: usersCount } = await supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", profile!.tenant_id);
  if ((usersCount ?? 0) >= (tenant?.max_users ?? 5)) {
    return res.status(400).json({ error: `وصلت إلى الحد الأقصى للمستخدمين (${tenant?.max_users})` });
  }

  // Create invitation
  const { data: invite, error } = await supabaseAdmin
    .from("tenant_invitations")
    .insert({ tenant_id: profile!.tenant_id, email, role, created_by: req.user!.id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const inviteUrl = `${process.env.FRONTEND_URL ?? "https://auto-parts-erp.vercel.app"}/signup?token=${invite.token}`;

  // Send invitation email
  await sendEmail({
    to: email,
    subject: `دعوة للانضمام إلى ${tenant?.name_ar ?? "AutoParts ERP"}`,
    html: inviteHtml({ inviteUrl, role, tenantName: tenant?.name_ar ?? "AutoParts ERP" }),
  });

  // Log notification
  await supabaseAdmin.from("notification_log").insert({
    tenant_id: profile!.tenant_id,
    type: "invite",
    recipient: email,
    subject: `دعوة للانضمام`,
    payload: { invite_id: invite.id, role },
  });

  res.json({ message: "تم إرسال الدعوة", token: invite.token });
});

// GET /api/settings/users — list tenant users
router.get("/users", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("tenant_id")
    .eq("id", req.user!.id)
    .single();

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id,full_name,email,role,created_at")
    .eq("tenant_id", profile!.tenant_id)
    .order("created_at");

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

export default router;
