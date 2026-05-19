import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT    = "d0000000-0000-0000-0000-000000000001";
const DEFAULT_WAREHOUSE = "e0000000-0000-0000-0000-000000000001";

function genQuoteNum() { return `QT-${Date.now().toString().slice(-7)}`; }
function genOrderNum() { return `SO-${Date.now().toString().slice(-8)}`; }

// GET /api/quotes
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, page = "1", limit = "50" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabaseAdmin
    .from("quotes")
    .select("*, customers(name,name_ar)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (status) query = query.eq("status", status);
  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count });
});

// GET /api/quotes/:id
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: quote, error } = await supabaseAdmin
    .from("quotes")
    .select("*, customers(name,name_ar,phone,city,tax_number)")
    .eq("id", req.params.id)
    .single();
  if (error || !quote) { res.status(404).json({ error: "عرض السعر غير موجود" }); return; }

  const { data: items } = await supabaseAdmin
    .from("quote_items")
    .select("*, parts(part_number,name,name_ar,unit)")
    .eq("quote_id", req.params.id);

  res.json({ ...quote, items: items ?? [] });
});

// POST /api/quotes
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { customer_id, items, valid_days = 7, notes, status = "draft" } = req.body as {
    customer_id?: string;
    items: { part_id: string; quantity: number; unit_price: number; discount_pct?: number }[];
    valid_days?: number;
    notes?: string;
    status?: string;
  };

  if (!items?.length) { res.status(400).json({ error: "يجب إضافة قطعة واحدة على الأقل" }); return; }

  const subtotal  = items.reduce((s, i) => s + i.quantity * i.unit_price * (1 - (i.discount_pct ?? 0) / 100), 0);
  const taxAmount = subtotal * 0.15;
  const total     = subtotal + taxAmount;

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + valid_days);

  const { data: quote, error } = await supabaseAdmin
    .from("quotes")
    .insert({
      tenant_id: DEFAULT_TENANT,
      quote_number: genQuoteNum(),
      customer_id: customer_id ?? null,
      status,
      valid_until: validUntil.toISOString().split("T")[0],
      subtotal, discount: 0, tax_amount: taxAmount, total,
      notes: notes ?? null,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (error || !quote) { res.status(400).json({ error: error?.message }); return; }

  await supabaseAdmin.from("quote_items").insert(
    items.map((i) => ({ quote_id: quote.id, part_id: i.part_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct ?? 0 }))
  );

  res.status(201).json({ ...quote, items });
});

// PUT /api/quotes/:id/status
router.put("/:id/status", requireAuth, async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  const valid = ["draft", "sent", "accepted", "rejected", "expired"];
  if (!valid.includes(status)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }

  const { data, error } = await supabaseAdmin
    .from("quotes")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/quotes/:id/convert — convert quote to sales order
router.post("/:id/convert", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: quote, error: qErr } = await supabaseAdmin
    .from("quotes")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (qErr || !quote) { res.status(404).json({ error: "عرض السعر غير موجود" }); return; }
  if (quote.status === "converted") { res.status(400).json({ error: "تم تحويل هذا العرض مسبقاً" }); return; }

  const { data: qItems } = await supabaseAdmin
    .from("quote_items").select("*").eq("quote_id", req.params.id);

  const { data: order, error: oErr } = await supabaseAdmin
    .from("sales_orders")
    .insert({
      tenant_id: DEFAULT_TENANT,
      order_number: genOrderNum(),
      customer_id: quote.customer_id ?? null,
      warehouse_id: DEFAULT_WAREHOUSE,
      status: "confirmed",
      payment_status: "unpaid",
      payment_method: "transfer",
      subtotal: quote.subtotal, discount: quote.discount, tax_amount: quote.tax_amount, total: quote.total,
      notes: `محوّل من عرض سعر #${quote.quote_number}`,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (oErr || !order) { res.status(400).json({ error: oErr?.message }); return; }

  await supabaseAdmin.from("sales_order_items").insert(
    (qItems ?? []).map((i) => ({ order_id: order.id, part_id: i.part_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct }))
  );

  await supabaseAdmin.from("quotes").update({ status: "converted", converted_order_id: order.id }).eq("id", req.params.id);
  res.json({ order, quote_id: req.params.id });
});

export default router;
