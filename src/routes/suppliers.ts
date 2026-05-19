import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { q, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("suppliers")
    .select("*", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (q) query = query.or(`name.ilike.%${q}%,name_ar.ilike.%${q}%,phone.ilike.%${q}%`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count });
});

router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from("suppliers").select("*").eq("id", req.params.id).single();
  if (error || !data) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  res.json(data);
});

router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, name_ar, phone, email, city, country, payment_terms, currency, contact_name, tax_number } = req.body;
  if (!name) { res.status(400).json({ error: "اسم المورد مطلوب" }); return; }

  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .insert({ tenant_id: DEFAULT_TENANT, name, name_ar, phone, email, city, country: country ?? "SA", payment_terms: payment_terms ?? 30, currency: currency ?? "SAR", contact_name, tax_number })
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from("suppliers").update(req.body).eq("id", req.params.id).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin.from("suppliers").update({ is_active: false }).eq("id", req.params.id);
  res.json({ message: "تم حذف المورد" });
});

export default router;
