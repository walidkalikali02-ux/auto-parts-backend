import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";

const router = Router();

// GET /api/vin/:vin
router.get("/:vin", async (req, res: Response) => {
  const { vin } = req.params;

  if (vin.length !== 17) {
    res.status(400).json({ error: "رمز VIN يجب أن يكون 17 خانة" }); return;
  }

  // Decode via NHTSA free API
  let decoded: Record<string, string> = {};
  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(vin)}?format=json`
    );
    const json = await response.json() as { Results: { Variable: string; Value: string }[] };
    const get = (name: string) => json.Results?.find((r) => r.Variable === name)?.Value ?? "";

    decoded = {
      year:       get("Model Year"),
      make:       get("Make"),
      model:      get("Model"),
      body_class: get("Body Class"),
      engine:     `${get("Displacement (L)")}L ${get("Engine Number of Cylinders")} cyl`,
      fuel:       get("Fuel Type - Primary"),
      drive:      get("Drive Type"),
      country:    get("Plant Country"),
    };

    if (!decoded.year || decoded.year === "0") {
      res.status(422).json({ error: "تعذّر فك رمز VIN — تحقق من الرقم" }); return;
    }
  } catch {
    res.status(503).json({ error: "خدمة فك VIN غير متاحة حالياً" }); return;
  }

  // Find compatible parts from DB
  const { data: models } = await supabaseAdmin
    .from("car_models")
    .select("id,name,name_ar,car_brands(name,name_ar)")
    .ilike("name", `%${decoded.model}%`)
    .eq("is_active", true);

  let compatibleParts: any[] = [];
  if (models?.length) {
    const modelIds = models.map((m) => m.id);
    const yearN    = parseInt(decoded.year);

    let q = supabaseAdmin
      .from("part_compatibility")
      .select(`
        id, year_from, year_to, engine_code,
        parts(id, part_number, name, name_ar, price_retail, condition,
          part_categories(name_ar))
      `)
      .in("car_model_id", modelIds);

    if (!isNaN(yearN)) q = q.lte("year_from", yearN).gte("year_to", yearN);

    const { data: compat } = await q.limit(50);

    const seen = new Set<string>();
    compatibleParts = (compat ?? []).filter((c: any) => {
      if (!c.parts?.id || seen.has(c.parts.id)) return false;
      seen.add(c.parts.id);
      return true;
    });
  }

  res.json({
    vin: vin.toUpperCase(),
    decoded,
    models_found: models ?? [],
    compatible_parts: compatibleParts,
    parts_count: compatibleParts.length,
  });
});

export default router;
