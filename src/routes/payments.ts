import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();
const DEFAULT_TENANT = "d0000000-0000-0000-0000-000000000001";

// POST /api/payments — record a payment against a sales order
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { order_id, amount, method = "cash", reference_no, notes } = req.body;
  if (!order_id || !amount) return res.status(400).json({ error: "order_id والمبلغ مطلوبان" });

  const { data: order, error: orderErr } = await supabaseAdmin
    .from("sales_orders")
    .select("id,total,customer_id,payment_status")
    .eq("id", order_id)
    .single();

  if (orderErr || !order) return res.status(404).json({ error: "الطلب غير موجود" });

  // Insert payment record
  const { data: payment, error } = await supabaseAdmin
    .from("payments")
    .insert({
      tenant_id:    DEFAULT_TENANT,
      order_id,
      customer_id:  order.customer_id,
      amount:       Number(amount),
      method,
      reference_no: reference_no || null,
      notes:        notes || null,
      created_by:   req.user!.id,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Recalculate payment status for the order
  const { data: allPayments } = await supabaseAdmin
    .from("payments")
    .select("amount")
    .eq("order_id", order_id);

  const totalPaid = (allPayments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const orderTotal = Number(order.total);
  const newPayStatus =
    totalPaid >= orderTotal ? "paid" :
    totalPaid > 0           ? "partial" : "unpaid";

  await supabaseAdmin
    .from("sales_orders")
    .update({ payment_status: newPayStatus })
    .eq("id", order_id);

  // Update customer balance if credit customer
  if (order.customer_id) {
    const { data: cust } = await supabaseAdmin
      .from("customers").select("balance").eq("id", order.customer_id).single();
    if (cust) {
      await supabaseAdmin
        .from("customers")
        .update({ balance: Math.max(0, Number(cust.balance) - Number(amount)) })
        .eq("id", order.customer_id);
    }
  }

  // Notify if fully paid
  if (newPayStatus === "paid") {
    const { data: profile } = await supabaseAdmin
      .from("profiles").select("id").eq("id", req.user!.id).single();
    if (profile) {
      await supabaseAdmin.from("notifications").insert({
        tenant_id: DEFAULT_TENANT,
        user_id:   req.user!.id,
        type:      "payment_received",
        title:     "تم استلام الدفع بالكامل",
        body:      `تم تسوية الطلب بالكامل. إجمالي مدفوع: ${totalPaid.toFixed(2)} ر.س`,
        link:      `/orders/sales/${order_id}`,
      });
    }
  }

  res.status(201).json({ ...payment, payment_status: newPayStatus, total_paid: totalPaid });
});

// GET /api/payments/order/:id — all payments for an order
router.get("/order/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("*, profiles(full_name,email)")
    .eq("order_id", req.params.id)
    .order("paid_at", { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/payments/customer/:id/statement — customer account statement
router.get("/customer/:id/statement", requireAuth, async (req: AuthRequest, res: Response) => {
  const { from, to } = req.query as Record<string, string>;

  const [ordersRes, paymentsRes, custRes] = await Promise.all([
    supabaseAdmin
      .from("sales_orders")
      .select("id,order_number,total,subtotal,tax_amount,payment_status,status,created_at,payment_method")
      .eq("customer_id", req.params.id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("payments")
      .select("id,amount,method,reference_no,paid_at,notes,order_id")
      .eq("customer_id", req.params.id)
      .order("paid_at", { ascending: false }),
    supabaseAdmin
      .from("customers")
      .select("id,name_ar,name,phone,email,tax_number,credit_limit,balance,city")
      .eq("id", req.params.id)
      .single(),
  ]);

  const orders   = ordersRes.data ?? [];
  const payments = paymentsRes.data ?? [];
  const customer = custRes.data;

  const totalOrders   = orders.reduce((s, o) => s + Number(o.total), 0);
  const totalPayments = payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance       = totalOrders - totalPayments;

  res.json({ customer, orders, payments, summary: { total_orders: totalOrders, total_payments: totalPayments, balance } });
});

// GET /api/payments/unpaid — all unpaid/partial orders across all customers
router.get("/unpaid", requireAuth, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("sales_orders")
    .select("id,order_number,total,payment_status,payment_method,created_at,customers(id,name_ar,phone,credit_limit,balance)")
    .in("payment_status", ["unpaid", "partial"])
    .neq("status", "cancelled")
    .neq("status", "returned")
    .order("created_at", { ascending: true });

  if (error) return res.status(400).json({ error: error.message });

  // Attach total paid per order
  const ids = (data ?? []).map((o) => o.id);
  if (!ids.length) return res.json([]);

  const { data: paidRows } = await supabaseAdmin
    .from("payments").select("order_id,amount").in("order_id", ids);

  const paidMap: Record<string, number> = {};
  (paidRows ?? []).forEach((p) => { paidMap[p.order_id] = (paidMap[p.order_id] ?? 0) + Number(p.amount); });

  res.json((data ?? []).map((o) => ({
    ...o,
    total_paid:    paidMap[o.id] ?? 0,
    remaining:     Number(o.total) - (paidMap[o.id] ?? 0),
    days_overdue:  Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000),
  })));
});

export default router;
