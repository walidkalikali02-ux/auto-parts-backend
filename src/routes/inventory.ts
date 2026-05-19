import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT    = "d0000000-0000-0000-0000-000000000001";
const DEFAULT_WAREHOUSE = "e0000000-0000-0000-0000-000000000001";

// GET /api/inventory
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { warehouse_id, status, q, page = "1", limit = "100" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("inventory")
    .select(`id, quantity, quantity_reserved, reorder_point, reorder_qty, location_code,
      parts(id,part_number,name,name_ar,price_retail,part_categories(name_ar)),
      warehouses(id,name,name_ar,city)`, { count: "exact" })
    .order("quantity", { ascending: true })
    .range(offset, offset + parseInt(limit) - 1);

  if (warehouse_id) query = query.eq("warehouse_id", warehouse_id);
  if (status === "out")  query = query.eq("quantity", 0);
  if (status === "low")  query = query.gt("quantity", 0).lt("quantity", 10);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  let result = data ?? [];
  if (q) {
    const lq = q.toLowerCase();
    result = result.filter((i: any) =>
      i.parts?.name_ar?.includes(q) || i.parts?.name?.toLowerCase().includes(lq) || i.parts?.part_number?.toLowerCase().includes(lq)
    );
  }
  res.json({ data: result, total: count });
});

// POST /api/inventory/adjust — adjust quantity
router.post("/adjust", requireAuth, async (req: AuthRequest, res: Response) => {
  const { inventory_id, type, quantity, reason } = req.body as {
    inventory_id: string; type: "add" | "remove" | "set"; quantity: number; reason?: string;
  };

  if (!inventory_id || !type || quantity === undefined) {
    res.status(400).json({ error: "inventory_id والنوع والكمية مطلوبة" });
    return;
  }

  const { data: inv, error: fetchErr } = await supabaseAdmin
    .from("inventory")
    .select("id, quantity, part_id, warehouse_id")
    .eq("id", inventory_id)
    .single();

  if (fetchErr || !inv) { res.status(404).json({ error: "السجل غير موجود" }); return; }

  const newQty =
    type === "add"    ? inv.quantity + quantity :
    type === "remove" ? Math.max(0, inv.quantity - quantity) :
    quantity;

  const delta = newQty - inv.quantity;

  const { data, error } = await supabaseAdmin
    .from("inventory")
    .update({ quantity: newQty, updated_at: new Date().toISOString() })
    .eq("id", inventory_id)
    .select()
    .single();

  if (error) { res.status(400).json({ error: error.message }); return; }

  // Log movement
  await supabaseAdmin.from("inventory_movements").insert({
    tenant_id:      DEFAULT_TENANT,
    part_id:        inv.part_id,
    warehouse_id:   inv.warehouse_id,
    movement_type:  "adjustment",
    quantity:       delta,
    notes:          reason ?? null,
    created_by:     req.user!.id,
  });

  res.json({ data, previous_qty: inv.quantity, new_qty: newQty, delta });
});

// GET /api/inventory/movements — audit log
router.get("/movements", requireAuth, async (req: AuthRequest, res: Response) => {
  const { part_id, limit = "50" } = req.query as Record<string, string>;
  let query = supabaseAdmin
    .from("inventory_movements")
    .select("*, parts(part_number,name_ar), warehouses(name_ar)")
    .order("created_at", { ascending: false })
    .limit(parseInt(limit));

  if (part_id) query = query.eq("part_id", part_id);
  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/inventory/low-stock
router.get("/low-stock", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("*, parts(part_number,name_ar,price_retail), warehouses(name_ar)")
    .lt("quantity", 10)
    .order("quantity", { ascending: true })
    .limit(50);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/inventory/warehouses
router.get("/warehouses", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("warehouses")
    .select("*")
    .eq("is_active", true)
    .order("is_default", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
