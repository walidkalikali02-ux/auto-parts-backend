import { Router, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";

const router = Router();

// GET /api/reports/daily?date=YYYY-MM-DD
router.get("/daily", requireAuth, async (req: AuthRequest, res: Response) => {
  const dateStr = (req.query.date as string) ?? new Date().toISOString().split("T")[0];
  const prevStr = new Date(new Date(dateStr).getTime() - 86400000).toISOString().split("T")[0];

  const [todayRes, yesterdayRes, inventoryRes] = await Promise.all([
    supabaseAdmin.from("sales_orders")
      .select("id,order_number,total,subtotal,tax_amount,status,payment_method,customers(name_ar)")
      .gte("created_at", `${dateStr}T00:00:00Z`)
      .lte("created_at", `${dateStr}T23:59:59Z`)
      .order("created_at", { ascending: false }),

    supabaseAdmin.from("sales_orders")
      .select("total,status")
      .gte("created_at", `${prevStr}T00:00:00Z`)
      .lte("created_at", `${prevStr}T23:59:59Z`),

    supabaseAdmin.from("inventory")
      .select("quantity,parts(price_retail)")
      .gt("quantity", 0),
  ]);

  const orders  = todayRes.data ?? [];
  const yOrders = yesterdayRes.data ?? [];
  const active  = orders.filter((o) => o.status !== "cancelled" && o.status !== "returned");
  const returned = orders.filter((o) => o.status === "returned");

  const totalSales   = active.reduce((s, o) => s + Number(o.total), 0);
  const totalVAT     = active.reduce((s, o) => s + Number(o.tax_amount), 0);
  const totalReturns = returned.reduce((s, o) => s + Math.abs(Number(o.total)), 0);
  const netRevenue   = totalSales - totalReturns;
  const yTotal       = yOrders.filter((o) => o.status !== "cancelled").reduce((s, o) => s + Number(o.total), 0);
  const growthPct    = yTotal > 0 ? ((totalSales - yTotal) / yTotal) * 100 : 0;

  const stockValue = (inventoryRes.data ?? []).reduce(
    (s: number, i: any) => s + i.quantity * (i.parts?.price_retail ?? 0), 0
  );

  // By payment method
  const byMethod: Record<string, number> = {};
  active.forEach((o) => { const m = o.payment_method ?? "cash"; byMethod[m] = (byMethod[m] ?? 0) + Number(o.total); });

  res.json({
    date: dateStr,
    summary: {
      total_sales:    totalSales,
      total_vat:      totalVAT,
      total_returns:  totalReturns,
      net_revenue:    netRevenue,
      orders_count:   active.length,
      returns_count:  returned.length,
      growth_pct:     Math.round(growthPct * 10) / 10,
      yesterday_total: yTotal,
      stock_value:    stockValue,
    },
    by_payment_method: byMethod,
    orders,
  });
});

// GET /api/reports/inventory
router.get("/inventory", requireAuth, async (req: AuthRequest, res: Response) => {
  const [totalRes, lowRes, outRes] = await Promise.all([
    supabaseAdmin.from("inventory").select("quantity,parts(price_retail,price_cost)"),
    supabaseAdmin.from("inventory").select("id,quantity,reorder_point,parts(part_number,name_ar,price_retail),warehouses(name_ar)").lt("quantity", 10).gt("quantity", 0).order("quantity"),
    supabaseAdmin.from("inventory").select("id,quantity,parts(part_number,name_ar),warehouses(name_ar)").eq("quantity", 0),
  ]);

  const all = totalRes.data ?? [];
  const totalCost  = all.reduce((s: number, i: any) => s + i.quantity * (i.parts?.price_cost ?? 0), 0);
  const totalRetail = all.reduce((s: number, i: any) => s + i.quantity * (i.parts?.price_retail ?? 0), 0);

  res.json({
    summary: {
      total_skus:   all.length,
      total_qty:    all.reduce((s, i) => s + i.quantity, 0),
      cost_value:   totalCost,
      retail_value: totalRetail,
      low_stock_count: (lowRes.data ?? []).length,
      out_of_stock_count: (outRes.data ?? []).length,
    },
    low_stock:    lowRes.data ?? [],
    out_of_stock: outRes.data ?? [],
  });
});

// GET /api/reports/dashboard — main KPIs
router.get("/dashboard", requireAuth, async (req: AuthRequest, res: Response) => {
  const [partsRes, ordersRes, customersRes, inventoryRes] = await Promise.all([
    supabaseAdmin.from("parts").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("sales_orders").select("total,status,created_at"),
    supabaseAdmin.from("customers").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("inventory").select("quantity").lt("quantity", 5),
  ]);

  const allOrders = ordersRes.data ?? [];
  const activeOrders = allOrders.filter((o) => o.status !== "cancelled" && o.status !== "returned");
  const totalRevenue = activeOrders.reduce((s, o) => s + Number(o.total), 0);

  // This month
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const monthRevenue = activeOrders
    .filter((o) => o.created_at >= monthStart)
    .reduce((s, o) => s + Number(o.total), 0);

  res.json({
    total_parts:     partsRes.count ?? 0,
    total_customers: customersRes.count ?? 0,
    total_orders:    allOrders.length,
    total_revenue:   totalRevenue,
    month_revenue:   monthRevenue,
    low_stock_count: (inventoryRes.data ?? []).length,
  });
});

export default router;
