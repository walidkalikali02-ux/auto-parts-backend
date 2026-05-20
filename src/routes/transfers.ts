import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

function genTransferNo() { return `TRF-${Date.now().toString().slice(-8)}`; }

// GET /api/transfers
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("stock_transfers")
    .select("*, from_wh:from_warehouse(name_ar), to_wh:to_warehouse(name_ar), profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/transfers/:id
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: transfer, error } = await supabaseAdmin
    .from("stock_transfers")
    .select("*, from_wh:from_warehouse(name_ar), to_wh:to_warehouse(name_ar)")
    .eq("id", req.params.id)
    .single();
  if (error || !transfer) return res.status(404).json({ error: "التحويل غير موجود" });

  const { data: items } = await supabaseAdmin
    .from("stock_transfer_items")
    .select("*, parts(part_number, name_ar, unit)")
    .eq("transfer_id", req.params.id);

  res.json({ ...transfer, items: items ?? [] });
});

// POST /api/transfers — create transfer
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { from_warehouse, to_warehouse, items, notes, status = "draft" } = req.body;

  if (!from_warehouse || !to_warehouse) return res.status(400).json({ error: "المستودع المصدر والمستودع الهدف مطلوبان" });
  if (from_warehouse === to_warehouse)  return res.status(400).json({ error: "لا يمكن التحويل إلى نفس المستودع" });
  if (!items?.length)                   return res.status(400).json({ error: "أضف قطعة واحدة على الأقل" });

  // Validate stock availability
  for (const item of items) {
    const { data: inv } = await supabaseAdmin
      .from("inventory").select("quantity")
      .eq("part_id", item.part_id).eq("warehouse_id", from_warehouse).single();
    if ((inv?.quantity ?? 0) < item.quantity) {
      const { data: part } = await supabaseAdmin.from("parts").select("name_ar").eq("id", item.part_id).single();
      return res.status(400).json({ error: `مخزون "${part?.name_ar}" غير كافٍ في المستودع المصدر (متاح: ${inv?.quantity ?? 0})` });
    }
  }

  const { data: transfer, error } = await supabaseAdmin
    .from("stock_transfers")
    .insert({
      tenant_id: DEFAULT_TENANT, transfer_number: genTransferNo(),
      from_warehouse, to_warehouse, status, notes: notes || null,
      created_by: req.user!.id,
    })
    .select().single();

  if (error || !transfer) return res.status(400).json({ error: error?.message });

  await supabaseAdmin.from("stock_transfer_items").insert(
    items.map((i: any) => ({ transfer_id: transfer.id, part_id: i.part_id, quantity: i.quantity }))
  );

  // If confirmed, move stock immediately
  if (status === "completed") await executeTransfer(transfer.id, from_warehouse, to_warehouse, items, DEFAULT_TENANT, req.user!.id);

  res.status(201).json(transfer);
});

// PUT /api/transfers/:id/complete — confirm and move stock
router.put("/:id/complete", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: transfer, error } = await supabaseAdmin
    .from("stock_transfers")
    .select("*, stock_transfer_items(part_id, quantity)")
    .eq("id", req.params.id)
    .single();

  if (error || !transfer) return res.status(404).json({ error: "التحويل غير موجود" });
  if (transfer.status === "completed") return res.status(400).json({ error: "تم تنفيذ هذا التحويل مسبقاً" });

  await executeTransfer(
    transfer.id, transfer.from_warehouse, transfer.to_warehouse,
    transfer.stock_transfer_items, DEFAULT_TENANT, req.user!.id
  );

  await supabaseAdmin.from("stock_transfers")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", req.params.id);

  res.json({ ok: true });
});

// PUT /api/transfers/:id/cancel
router.put("/:id/cancel", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin.from("stock_transfers").update({ status: "cancelled" }).eq("id", req.params.id);
  res.json({ ok: true });
});

async function executeTransfer(
  transferId: string, fromWh: string, toWh: string,
  items: { part_id: string; quantity: number }[],
  tenantId: string, userId: string
) {
  for (const item of items) {
    // Deduct from source
    const { data: src } = await supabaseAdmin.from("inventory").select("id,quantity")
      .eq("part_id", item.part_id).eq("warehouse_id", fromWh).single();
    if (src) {
      await supabaseAdmin.from("inventory").update({ quantity: Math.max(0, src.quantity - item.quantity) }).eq("id", src.id);
      await supabaseAdmin.from("inventory_movements").insert({
        tenant_id: tenantId, part_id: item.part_id, warehouse_id: fromWh,
        movement_type: "transfer_out", quantity: -item.quantity,
        reference_type: "transfer", reference_id: transferId, created_by: userId,
      });
    }
    // Add to destination
    const { data: dst } = await supabaseAdmin.from("inventory").select("id,quantity")
      .eq("part_id", item.part_id).eq("warehouse_id", toWh).single();
    if (dst) {
      await supabaseAdmin.from("inventory").update({ quantity: dst.quantity + item.quantity }).eq("id", dst.id);
    } else {
      await supabaseAdmin.from("inventory").insert({
        tenant_id: tenantId, part_id: item.part_id, warehouse_id: toWh,
        quantity: item.quantity, reorder_point: 5,
      });
    }
    await supabaseAdmin.from("inventory_movements").insert({
      tenant_id: tenantId, part_id: item.part_id, warehouse_id: toWh,
      movement_type: "transfer_in", quantity: item.quantity,
      reference_type: "transfer", reference_id: transferId, created_by: userId,
    });
  }
}

export default router;
