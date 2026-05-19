import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

// GET /api/customers
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { q, type, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("customers")
    .select("*", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (q)    query = query.or(`name.ilike.%${q}%,name_ar.ilike.%${q}%,phone.ilike.%${q}%`);
  if (type) query = query.eq("customer_type", type);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count });
});

// GET /api/customers/:id
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: customer, error } = await supabaseAdmin
    .from("customers").select("*").eq("id", req.params.id).single();
  if (error || !customer) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  const [vehicles, orders] = await Promise.all([
    supabaseAdmin.from("customer_vehicles")
      .select("*, car_brands(name,name_ar), car_models(name,name_ar)")
      .eq("customer_id", req.params.id).eq("is_active", true),
    supabaseAdmin.from("sales_orders")
      .select("id,order_number,total,status,payment_status,order_date")
      .eq("customer_id", req.params.id)
      .order("created_at", { ascending: false }).limit(10),
  ]);

  res.json({ ...customer, vehicles: vehicles.data ?? [], orders: orders.data ?? [] });
});

// POST /api/customers
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, name_ar, phone, email, city, customer_type, credit_limit, tax_number } = req.body;
  if (!name_ar && !name) { res.status(400).json({ error: "اسم العميل مطلوب" }); return; }

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert({ tenant_id: DEFAULT_TENANT, name: name || name_ar, name_ar, phone, email, city, customer_type: customer_type ?? "retail", credit_limit: credit_limit ?? 0, tax_number })
    .select()
    .single();

  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PUT /api/customers/:id
router.put("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("customers").update(req.body).eq("id", req.params.id).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/customers/:id — soft delete
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin.from("customers").update({ is_active: false }).eq("id", req.params.id);
  res.json({ message: "تم حذف العميل" });
});

// GET /api/customers/:id/vehicles
router.get("/:id/vehicles", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("customer_vehicles")
    .select("*, car_brands(name,name_ar), car_models(name,name_ar)")
    .eq("customer_id", req.params.id)
    .eq("is_active", true);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/customers/:id/vehicles
router.post("/:id/vehicles", requireAuth, async (req: AuthRequest, res: Response) => {
  const { plate_number, vin, car_brand_id, car_model_id, year, color, engine_code, mileage, notes } = req.body;
  if (!plate_number) { res.status(400).json({ error: "رقم اللوحة مطلوب" }); return; }

  const { data, error } = await supabaseAdmin
    .from("customer_vehicles")
    .insert({ customer_id: req.params.id, plate_number, vin, car_brand_id, car_model_id, year, color, engine_code, mileage, notes })
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PUT /api/customers/:id/vehicles/:vehicleId
router.put("/:id/vehicles/:vehicleId", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("customer_vehicles").update(req.body).eq("id", req.params.vehicleId).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/customers/:id/vehicles/:vehicleId
router.delete("/:id/vehicles/:vehicleId", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin.from("customer_vehicles").update({ is_active: false }).eq("id", req.params.vehicleId);
  res.json({ message: "تم حذف السيارة" });
});

// GET /api/customers/:id/orders
router.get("/:id/orders", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("sales_orders")
    .select("id,order_number,total,status,payment_status,order_date")
    .eq("customer_id", req.params.id)
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
