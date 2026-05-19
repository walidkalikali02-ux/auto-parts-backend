import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT    = "d0000000-0000-0000-0000-000000000001";
const DEFAULT_WAREHOUSE = "e0000000-0000-0000-0000-000000000001";

function genSalesNum() { return `SO-${Date.now().toString().slice(-8)}`; }
function genPONum()    { return `PO-${Date.now().toString().slice(-8)}`; }
function genRetNum()   { return `RET-${Date.now().toString().slice(-7)}`; }

// ============================================================
// SALES ORDERS
// ============================================================

// GET /api/orders/sales
router.get("/sales", requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, payment_status, customer_id, q, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("sales_orders")
    .select("*, customers(name,name_ar,phone)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (status)         query = query.eq("status", status);
  if (payment_status) query = query.eq("payment_status", payment_status);
  if (customer_id)    query = query.eq("customer_id", customer_id);
  if (q)              query = query.ilike("order_number", `%${q}%`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/orders/sales/:id
router.get("/sales/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: order, error } = await supabaseAdmin
    .from("sales_orders")
    .select("*, customers(name,name_ar,phone,email,tax_number,city)")
    .eq("id", req.params.id)
    .single();
  if (error || !order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

  const { data: items } = await supabaseAdmin
    .from("sales_order_items")
    .select("*, parts(part_number,name,name_ar,unit,tax_rate)")
    .eq("order_id", req.params.id);

  res.json({ ...order, items: items ?? [] });
});

// POST /api/orders/sales — create new sales order
router.post("/sales", requireAuth, async (req: AuthRequest, res: Response) => {
  const { customer_id, items, payment_method, notes, status = "confirmed" } = req.body as {
    customer_id?: string;
    items: { part_id: string; quantity: number; unit_price: number; discount_pct?: number }[];
    payment_method?: string;
    notes?: string;
    status?: string;
  };

  if (!items?.length) { res.status(400).json({ error: "يجب إضافة قطعة واحدة على الأقل" }); return; }

  // Stock validation
  for (const item of items) {
    const { data: inv } = await supabaseAdmin
      .from("inventory")
      .select("quantity")
      .eq("part_id", item.part_id)
      .eq("warehouse_id", DEFAULT_WAREHOUSE)
      .single();

    if ((inv?.quantity ?? 0) < item.quantity) {
      const { data: part } = await supabaseAdmin.from("parts").select("name_ar").eq("id", item.part_id).single();
      res.status(400).json({ error: `مخزون "${part?.name_ar}" غير كافٍ (متاح: ${inv?.quantity ?? 0})` });
      return;
    }
  }

  // Credit limit check
  if (payment_method === "credit" && customer_id) {
    const { data: cust } = await supabaseAdmin
      .from("customers").select("credit_limit,balance,name_ar").eq("id", customer_id).single();
    if (cust) {
      const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - (i.discount_pct ?? 0) / 100), 0);
      const total    = subtotal * 1.15;
      const available = (cust.credit_limit ?? 0) - (cust.balance ?? 0);
      if (total > available) {
        res.status(400).json({ error: `رصيد الائتمان لـ "${cust.name_ar}" غير كافٍ (المتاح: ${available.toFixed(2)} ر.س)` });
        return;
      }
    }
  }

  const subtotal  = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - (i.discount_pct ?? 0) / 100), 0);
  const taxAmount = subtotal * 0.15;
  const total     = subtotal + taxAmount;

  const { data: order, error: orderErr } = await supabaseAdmin
    .from("sales_orders")
    .insert({
      tenant_id: DEFAULT_TENANT,
      order_number: genSalesNum(),
      customer_id: customer_id ?? null,
      warehouse_id: DEFAULT_WAREHOUSE,
      status,
      payment_status: "unpaid",
      payment_method: payment_method ?? "cash",
      subtotal, discount: 0, tax_amount: taxAmount, total,
      notes: notes ?? null,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (orderErr || !order) { res.status(400).json({ error: orderErr?.message }); return; }

  await supabaseAdmin.from("sales_order_items").insert(
    items.map((i) => ({
      order_id: order.id,
      part_id: i.part_id,
      quantity: i.quantity,
      unit_price: i.unit_price,
      discount_pct: i.discount_pct ?? 0,
    }))
  );

  // Deduct inventory
  if (status === "confirmed" || status === "delivered") {
    await Promise.all(items.map(async (i) => {
      const { data: inv } = await supabaseAdmin
        .from("inventory").select("id,quantity").eq("part_id", i.part_id).eq("warehouse_id", DEFAULT_WAREHOUSE).single();
      if (inv) {
        await supabaseAdmin.from("inventory").update({ quantity: Math.max(0, inv.quantity - i.quantity) }).eq("id", inv.id);
        await supabaseAdmin.from("inventory_movements").insert({
          tenant_id: DEFAULT_TENANT, part_id: i.part_id, warehouse_id: DEFAULT_WAREHOUSE,
          movement_type: "sale", quantity: -i.quantity, reference_type: "sales_order", reference_id: order.id,
          created_by: req.user!.id,
        });
      }
    }));
  }

  res.status(201).json({ ...order, items });
});

// PUT /api/orders/sales/:id/status
router.put("/sales/:id/status", requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, payment_status } = req.body;
  const update: Record<string, string> = {};
  if (status)         update.status = status;
  if (payment_status) update.payment_status = payment_status;

  const { data, error } = await supabaseAdmin
    .from("sales_orders")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/orders/returns — create return order
router.post("/returns", requireAuth, async (req: AuthRequest, res: Response) => {
  const { original_order_id, items, reason } = req.body as {
    original_order_id: string;
    items: { part_id: string; quantity: number; unit_price: number }[];
    reason: string;
  };

  const { data: original } = await supabaseAdmin
    .from("sales_orders").select("order_number,customer_id,payment_method").eq("id", original_order_id).single();

  const total = items.reduce((s, i) => s + i.quantity * i.unit_price * 1.15, 0);

  const { data: ret, error } = await supabaseAdmin
    .from("sales_orders")
    .insert({
      tenant_id: DEFAULT_TENANT,
      order_number: genRetNum(),
      customer_id: original?.customer_id ?? null,
      warehouse_id: DEFAULT_WAREHOUSE,
      status: "returned",
      payment_status: "refunded",
      payment_method: original?.payment_method ?? "cash",
      subtotal: -(total / 1.15),
      discount: 0,
      tax_amount: -(total * 0.15 / 1.15),
      total: -total,
      notes: `إرجاع من طلب #${original?.order_number} — ${reason}`,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (error || !ret) { res.status(400).json({ error: error?.message }); return; }

  await supabaseAdmin.from("sales_order_items").insert(
    items.map((i) => ({ order_id: ret.id, part_id: i.part_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: 0 }))
  );

  // Restore inventory
  await Promise.all(items.map(async (i) => {
    const { data: inv } = await supabaseAdmin
      .from("inventory").select("id,quantity").eq("part_id", i.part_id).eq("warehouse_id", DEFAULT_WAREHOUSE).single();
    if (inv) {
      await supabaseAdmin.from("inventory").update({ quantity: inv.quantity + i.quantity }).eq("id", inv.id);
    }
  }));

  res.status(201).json(ret);
});

// ============================================================
// PURCHASE ORDERS
// ============================================================

// GET /api/orders/purchase
router.get("/purchase", requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("purchase_orders")
    .select("*, suppliers(name,name_ar)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (status) query = query.eq("status", status);
  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count });
});

// GET /api/orders/purchase/:id
router.get("/purchase/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: po, error } = await supabaseAdmin
    .from("purchase_orders")
    .select("*, suppliers(name,name_ar,phone,email,city,country)")
    .eq("id", req.params.id)
    .single();
  if (error || !po) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }

  const { data: items } = await supabaseAdmin
    .from("purchase_order_items")
    .select("*, parts(part_number,name_ar)")
    .eq("po_id", req.params.id);

  res.json({ ...po, items: items ?? [] });
});

// POST /api/orders/purchase — create PO
router.post("/purchase", requireAuth, async (req: AuthRequest, res: Response) => {
  const { supplier_id, items, expected_date, notes } = req.body as {
    supplier_id: string;
    items: { part_id: string; quantity_ordered: number; unit_cost: number }[];
    expected_date?: string;
    notes?: string;
  };

  if (!supplier_id || !items?.length) {
    res.status(400).json({ error: "المورد وعناصر الطلب مطلوبان" }); return;
  }

  const subtotal = items.reduce((s, i) => s + i.quantity_ordered * i.unit_cost, 0);
  const taxAmount = subtotal * 0.15;
  const total = subtotal + taxAmount;

  const { data: po, error } = await supabaseAdmin
    .from("purchase_orders")
    .insert({
      tenant_id: DEFAULT_TENANT,
      po_number: genPONum(),
      supplier_id,
      warehouse_id: DEFAULT_WAREHOUSE,
      status: "draft",
      order_date: new Date().toISOString().split("T")[0],
      expected_date: expected_date ?? null,
      subtotal, tax_amount: taxAmount, total,
      notes: notes ?? null,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (error || !po) { res.status(400).json({ error: error?.message }); return; }

  await supabaseAdmin.from("purchase_order_items").insert(
    items.map((i) => ({ po_id: po.id, part_id: i.part_id, quantity_ordered: i.quantity_ordered, unit_cost: i.unit_cost }))
  );

  res.status(201).json({ ...po, items });
});

// PUT /api/orders/purchase/:id/receive — receive PO + update inventory
router.put("/purchase/:id/receive", requireAuth, async (req: AuthRequest, res: Response) => {
  const { received_items } = req.body as {
    received_items: { item_id: string; part_id: string; quantity_received: number }[];
  };

  await Promise.all(received_items.map(async (ri) => {
    await supabaseAdmin.from("purchase_order_items")
      .update({ quantity_received: ri.quantity_received })
      .eq("id", ri.item_id);

    const { data: inv } = await supabaseAdmin
      .from("inventory").select("id,quantity").eq("part_id", ri.part_id).eq("warehouse_id", DEFAULT_WAREHOUSE).single();

    if (inv) {
      await supabaseAdmin.from("inventory").update({ quantity: inv.quantity + ri.quantity_received }).eq("id", inv.id);
    } else {
      await supabaseAdmin.from("inventory").insert({
        tenant_id: DEFAULT_TENANT, part_id: ri.part_id, warehouse_id: DEFAULT_WAREHOUSE,
        quantity: ri.quantity_received, reorder_point: 5, reorder_qty: 20,
      });
    }

    await supabaseAdmin.from("inventory_movements").insert({
      tenant_id: DEFAULT_TENANT, part_id: ri.part_id, warehouse_id: DEFAULT_WAREHOUSE,
      movement_type: "purchase", quantity: ri.quantity_received,
      reference_type: "purchase_order", reference_id: req.params.id,
      created_by: req.user!.id,
    });
  }));

  const { data, error } = await supabaseAdmin
    .from("purchase_orders")
    .update({ status: "received", received_date: new Date().toISOString().split("T")[0] })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
