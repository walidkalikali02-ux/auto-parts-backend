import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();

// GET /api/compatibility?brand_id=&model_id=&year=
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { brand_id, model_id, year, category_id } = req.query as Record<string, string>;

  if (!model_id && !brand_id) {
    res.status(400).json({ error: "يجب تحديد brand_id أو model_id" }); return;
  }

  let modelIds: string[] = [];

  if (model_id) {
    modelIds = [model_id];
  } else if (brand_id) {
    const { data: models } = await supabaseAdmin
      .from("car_models")
      .select("id")
      .eq("brand_id", brand_id)
      .eq("is_active", true);
    modelIds = (models ?? []).map((m) => m.id);
  }

  if (!modelIds.length) { res.json([]); return; }

  let query = supabaseAdmin
    .from("part_compatibility")
    .select(`
      id, year_from, year_to, engine_code, notes,
      car_models(id, name, name_ar, body_type, car_brands(name, name_ar)),
      parts(id, part_number, oem_number, name, name_ar, price_retail, condition,
        part_categories(name_ar))
    `)
    .in("car_model_id", modelIds);

  if (year) {
    const y = parseInt(year);
    query = query.lte("year_from", y).gte("year_to", y);
  }

  const { data, error } = await query.limit(100);
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Deduplicate by part
  const seen = new Set<string>();
  const unique = (data ?? []).filter((c: any) => {
    if (!c.parts?.id || seen.has(c.parts.id)) return false;
    if (category_id && c.parts?.part_categories_id !== category_id) return false;
    seen.add(c.parts.id);
    return true;
  });

  res.json(unique);
});

// GET /api/compatibility/brands — all car brands
router.get("/brands", async (_req, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("car_brands")
    .select("id,name,name_ar,country,logo_url")
    .eq("is_active", true)
    .order("name_ar");
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/compatibility/models?brand_id=
router.get("/models", async (req, res: Response) => {
  const { brand_id } = req.query as { brand_id?: string };
  let query = supabaseAdmin
    .from("car_models")
    .select("id,brand_id,name,name_ar,body_type,year_start,year_end,car_brands(name,name_ar)")
    .eq("is_active", true)
    .order("name");

  if (brand_id) query = query.eq("brand_id", brand_id);
  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/compatibility/categories
router.get("/categories", async (_req, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("part_categories")
    .select("id,name,name_ar,icon,sort_order,parent_id")
    .eq("is_active", true)
    .order("sort_order");
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
