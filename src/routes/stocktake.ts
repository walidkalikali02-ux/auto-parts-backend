import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT    = "d0000000-0000-0000-0000-000000000001";
const DEFAULT_WAREHOUSE = "e0000000-0000-0000-0000-000000000001";

// GET /api/stocktake — list stocktakes
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data } = await supabaseAdmin
    .from("stocktakes")
    .select("*, warehouses(name_ar), profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(20);
  res.json(data ?? []);
});

// POST /api/stocktake — start a new stocktake
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { warehouse_id = DEFAULT_WAREHOUSE, notes } = req.body;

  // Check no open stocktake for this warehouse
  const { data: existing } = await supabaseAdmin
    .from("stocktakes").select("id")
    .eq("warehouse_id", warehouse_id).eq("status", "open").single();
  if (existing) return res.status(400).json({ error: "يوجد جرد مفتوح بالفعل لهذا المستودع" });

  const { data: stocktake, error } = await supabaseAdmin
    .from("stocktakes")
    .insert({ tenant_id: DEFAULT_TENANT, warehouse_id, notes: notes || null, started_by: req.user!.id })
    .select().single();

  if (error || !stocktake) return res.status(400).json({ error: error?.message });

  // Snapshot current inventory
  const { data: inventory } = await supabaseAdmin
    .from("inventory")
    .select("part_id, quantity")
    .eq("warehouse_id", warehouse_id);

  if (inventory?.length) {
    await supabaseAdmin.from("stocktake_items").insert(
      inventory.map((i) => ({
        stocktake_id: stocktake.id,
        part_id:      i.part_id,
        system_qty:   i.quantity,
        counted_qty:  null,
      }))
    );
  }

  res.status(201).json(stocktake);
});

// GET /api/stocktake/:id — get stocktake with items
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: stocktake, error } = await supabaseAdmin
    .from("stocktakes")
    .select("*, warehouses(name_ar)")
    .eq("id", req.params.id)
    .single();

  if (error || !stocktake) return res.status(404).json({ error: "الجرد غير موجود" });

  const { data: items } = await supabaseAdmin
    .from("stocktake_items")
    .select("*, parts(part_number, name_ar, name, unit, part_categories(name_ar))")
    .eq("stocktake_id", req.params.id)
    .order("created_at");

  res.json({ ...stocktake, items: items ?? [] });
});

// PUT /api/stocktake/:id/count — update counted qty for items
router.put("/:id/count", requireAuth, async (req: AuthRequest, res: Response) => {
  const { counts } = req.body as { counts: { item_id: string; counted_qty: number }[] };
  if (!counts?.length) return res.status(400).json({ error: "counts مطلوبة" });

  await Promise.all(counts.map((c) =>
    supabaseAdmin.from("stocktake_items")
      .update({ counted_qty: c.counted_qty, counted_at: new Date().toISOString() })
      .eq("id", c.item_id)
  ));

  res.json({ ok: true, updated: counts.length });
});

// POST /api/stocktake/:id/complete — apply adjustments to inventory
router.post("/:id/complete", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: stocktake, error } = await supabaseAdmin
    .from("stocktakes")
    .select("*, stocktake_items(id, part_id, system_qty, counted_qty, variance)")
    .eq("id", req.params.id)
    .single();

  if (error || !stocktake) return res.status(404).json({ error: "الجرد غير موجود" });
  if (stocktake.status === "completed") return res.status(400).json({ error: "تم إغلاق هذا الجرد" });

  const items = stocktake.stocktake_items ?? [];
  const adjusted = items.filter((i: any) => i.counted_qty !== null && i.variance !== 0);
  let adjustedCount = 0;

  for (const item of adjusted) {
    const { data: inv } = await supabaseAdmin
      .from("inventory").select("id")
      .eq("part_id", item.part_id).eq("warehouse_id", stocktake.warehouse_id).single();

    if (inv) {
      await supabaseAdmin.from("inventory").update({ quantity: item.counted_qty }).eq("id", inv.id);
      await supabaseAdmin.from("inventory_movements").insert({
        tenant_id:      DEFAULT_TENANT,
        part_id:        item.part_id,
        warehouse_id:   stocktake.warehouse_id,
        movement_type:  "adjustment",
        quantity:       item.variance,
        reference_type: "stocktake",
        reference_id:   stocktake.id,
        notes:          `تسوية جرد — النظام: ${item.system_qty}، الفعلي: ${item.counted_qty}`,
        created_by:     req.user!.id,
      });
      adjustedCount++;
    }
  }

  await supabaseAdmin.from("stocktakes")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", req.params.id);

  res.json({ ok: true, adjusted: adjustedCount, skipped: items.length - adjusted.length });
});

// GET /api/stocktake/reorder/suggestions — parts needing reorder
router.get("/reorder/suggestions", requireAuth, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("reorder_suggestions")
    .select("*");

  if (error) return res.status(400).json({ error: error.message });

  const totalCost = (data ?? []).reduce((s, r) => s + Number(r.estimated_cost), 0);
  res.json({ items: data ?? [], total_estimated_cost: totalCost });
});

export default router;
