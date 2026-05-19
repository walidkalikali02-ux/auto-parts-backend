import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

// GET /api/parts — search + filter
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { q, category_id, condition, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("parts")
    .select("*, part_categories(id,name,name_ar)", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (q)           query = query.or(`name.ilike.%${q}%,name_ar.ilike.%${q}%,part_number.ilike.%${q}%,oem_number.ilike.%${q}%`);
  if (category_id) query = query.eq("category_id", category_id);
  if (condition)   query = query.eq("condition", condition);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/parts/:id
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("parts")
    .select("*, part_categories(name,name_ar)")
    .eq("id", req.params.id)
    .single();
  if (error || !data) { res.status(404).json({ error: "القطعة غير موجودة" }); return; }
  res.json(data);
});

// POST /api/parts — create
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { part_number, name, name_ar, price_cost, price_retail, ...rest } = req.body;
  if (!part_number || !name_ar || price_retail === undefined) {
    res.status(400).json({ error: "رقم القطعة والاسم وسعر البيع مطلوبة" });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("parts")
    .insert({ tenant_id: DEFAULT_TENANT, part_number, name: name || name_ar, name_ar, price_cost: price_cost ?? 0, price_retail, ...rest })
    .select()
    .single();

  if (error) {
    const msg = error.message.includes("unique") ? "رقم القطعة مستخدم مسبقاً" : error.message;
    res.status(400).json({ error: msg });
    return;
  }
  res.status(201).json(data);
});

// PUT /api/parts/:id — update
router.put("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("parts")
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/parts/:id — soft delete
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { error } = await supabaseAdmin
    .from("parts")
    .update({ is_active: false })
    .eq("id", req.params.id);
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json({ message: "تم حذف القطعة" });
});

// GET /api/parts/:id/compatibility
router.get("/:id/compatibility", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("part_compatibility")
    .select("*, car_models(id,name,name_ar,body_type,year_start,year_end,car_brands(name,name_ar))")
    .eq("part_id", req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/parts/:id/compatibility — add compatibility
router.post("/:id/compatibility", requireAuth, async (req: AuthRequest, res: Response) => {
  const { car_model_id, year_from, year_to, engine_code, notes } = req.body;
  if (!car_model_id) { res.status(400).json({ error: "car_model_id مطلوب" }); return; }

  const { data, error } = await supabaseAdmin
    .from("part_compatibility")
    .insert({ part_id: req.params.id, car_model_id, year_from, year_to, engine_code, notes })
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// GET /api/parts/:id/cross-refs
router.get("/:id/cross-refs", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("part_cross_references")
    .select("*")
    .eq("part_id", req.params.id)
    .order("ref_type");
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/parts/:id/cross-refs
router.post("/:id/cross-refs", requireAuth, async (req: AuthRequest, res: Response) => {
  const { ref_number, brand, ref_type } = req.body;
  if (!ref_number) { res.status(400).json({ error: "ref_number مطلوب" }); return; }

  const { data, error } = await supabaseAdmin
    .from("part_cross_references")
    .insert({ part_id: req.params.id, ref_number, brand, ref_type: ref_type ?? "oem" })
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// GET /api/parts/:id/substitutes
router.get("/:id/substitutes", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("part_substitutes")
    .select("*, parts!part_substitutes_substitute_id_fkey(id,part_number,name_ar,price_retail,condition)")
    .eq("part_id", req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/parts/:id/inventory
router.get("/:id/inventory", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("*, warehouses(name,name_ar,city)")
    .eq("part_id", req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
