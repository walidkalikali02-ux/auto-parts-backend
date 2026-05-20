import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

// GET /api/notifications — get current user's notifications
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(400).json({ error: error.message });

  const unread = (data ?? []).filter((n) => !n.is_read).length;
  res.json({ notifications: data ?? [], unread });
});

// PUT /api/notifications/:id/read — mark one as read
router.put("/:id/read", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin
    .from("notifications")
    .update({ is_read: true })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id);
  res.json({ ok: true });
});

// PUT /api/notifications/read-all — mark all as read
router.put("/read-all", requireAuth, async (req: AuthRequest, res: Response) => {
  await supabaseAdmin
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", req.user!.id)
    .eq("is_read", false);
  res.json({ ok: true });
});

// POST /api/notifications/generate — scan for system alerts and create notifications
router.post("/generate", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const created: string[] = [];

  // Low stock alerts
  const { data: lowStockItems } = await supabaseAdmin
    .from("inventory")
    .select("quantity, reorder_point, parts(part_number, name_ar)")
    .lt("quantity", 5)
    .gt("quantity", -1);

  for (const item of (lowStockItems ?? [])) {
    const part = (item as any).parts;
    const { data: existing } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "low_stock")
      .eq("payload->part_number", part?.part_number)
      .gte("created_at", new Date(Date.now() - 86400000).toISOString())
      .limit(1)
      .single();

    if (!existing) {
      await supabaseAdmin.from("notifications").insert({
        tenant_id: DEFAULT_TENANT, user_id: userId,
        type: item.quantity === 0 ? "out_of_stock" : "low_stock",
        title: item.quantity === 0 ? `نفد المخزون: ${part?.name_ar}` : `مخزون منخفض: ${part?.name_ar}`,
        body: `الكمية المتبقية: ${item.quantity} (حد إعادة الطلب: ${item.reorder_point ?? 5})`,
        link: "/inventory",
        payload: { part_number: part?.part_number, quantity: item.quantity },
      });
      created.push(part?.part_number);
    }
  }

  // Unpaid orders older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: unpaidOld } = await supabaseAdmin
    .from("sales_orders")
    .select("id, order_number, total, customers(name_ar)")
    .in("payment_status", ["unpaid", "partial"])
    .neq("status", "cancelled")
    .lt("created_at", sevenDaysAgo)
    .limit(10);

  for (const order of (unpaidOld ?? [])) {
    const { data: existing } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "overdue_payment")
      .eq("payload->order_id", order.id)
      .gte("created_at", new Date(Date.now() - 86400000).toISOString())
      .limit(1)
      .single();

    if (!existing) {
      const cust = (order as any).customers;
      await supabaseAdmin.from("notifications").insert({
        tenant_id: DEFAULT_TENANT, user_id: userId,
        type: "overdue_payment",
        title: `دفعة متأخرة: #${order.order_number}`,
        body: `${cust?.name_ar ?? "عميل"} · ${Number(order.total).toFixed(2)} ر.س · متأخر أكثر من 7 أيام`,
        link: `/orders/sales/${order.id}`,
        payload: { order_id: order.id },
      });
      created.push(order.order_number);
    }
  }

  res.json({ created: created.length, items: created });
});

export default router;
