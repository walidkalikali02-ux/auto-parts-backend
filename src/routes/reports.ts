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

// GET /api/reports/dashboard — main KPIs + analytics
router.get("/dashboard", requireAuth, async (req: AuthRequest, res: Response) => {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  // Last 30 days window
  const day30ago = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];
  // Last 6 months
  const month6ago = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().split("T")[0];

  const [partsRes, ordersRes, customersRes, inventoryRes, trend30Res, topPartsRes, topCustomersRes, monthlySalesRes] = await Promise.all([
    supabaseAdmin.from("parts").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("sales_orders").select("total,status,created_at"),
    supabaseAdmin.from("customers").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("inventory").select("quantity").lt("quantity", 5),
    // Revenue last 30 days (daily)
    supabaseAdmin.from("sales_orders")
      .select("total,status,created_at")
      .gte("created_at", `${day30ago}T00:00:00Z`)
      .neq("status", "cancelled")
      .neq("status", "returned"),
    // Top parts by units sold (via sales_order_items)
    supabaseAdmin.from("sales_order_items")
      .select("quantity,unit_price,parts(part_number,name_ar)")
      .limit(200),
    // Top customers by spend
    supabaseAdmin.from("sales_orders")
      .select("total,status,customers(name_ar)")
      .neq("status", "cancelled")
      .neq("status", "returned"),
    // Monthly revenue last 6 months
    supabaseAdmin.from("sales_orders")
      .select("total,status,created_at")
      .gte("created_at", `${month6ago}T00:00:00Z`)
      .neq("status", "cancelled")
      .neq("status", "returned"),
  ]);

  const allOrders = ordersRes.data ?? [];
  const activeOrders = allOrders.filter((o) => o.status !== "cancelled" && o.status !== "returned");
  const totalRevenue = activeOrders.reduce((s, o) => s + Number(o.total), 0);
  const monthRevenue = activeOrders
    .filter((o) => o.created_at >= monthStart)
    .reduce((s, o) => s + Number(o.total), 0);

  // Revenue trend: last 30 days, one entry per day
  const trendMap: Record<string, number> = {};
  (trend30Res.data ?? []).forEach((o) => {
    const d = o.created_at.slice(0, 10);
    trendMap[d] = (trendMap[d] ?? 0) + Number(o.total);
  });
  const revenueTrend: { date: string; revenue: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().split("T")[0];
    revenueTrend.push({ date: d, revenue: Math.round((trendMap[d] ?? 0) * 100) / 100 });
  }

  // Top parts by units sold
  const partsMap: Record<string, { name: string; qty: number; revenue: number }> = {};
  (topPartsRes.data ?? []).forEach((item: any) => {
    const key = item.parts?.part_number ?? "unknown";
    const name = item.parts?.name_ar ?? key;
    if (!partsMap[key]) partsMap[key] = { name, qty: 0, revenue: 0 };
    partsMap[key].qty += item.quantity;
    partsMap[key].revenue += item.quantity * Number(item.unit_price ?? 0);
  });
  const topParts = Object.entries(partsMap)
    .map(([part_number, v]) => ({ part_number, ...v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 7);

  // Top customers by spend
  const custMap: Record<string, number> = {};
  (topCustomersRes.data ?? []).forEach((o: any) => {
    const name = o.customers?.name_ar ?? "نقدي";
    custMap[name] = (custMap[name] ?? 0) + Number(o.total);
  });
  const topCustomers = Object.entries(custMap)
    .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Monthly revenue (last 6 months)
  const monthlyMap: Record<string, number> = {};
  (monthlySalesRes.data ?? []).forEach((o) => {
    const m = o.created_at.slice(0, 7); // "YYYY-MM"
    monthlyMap[m] = (monthlyMap[m] ?? 0) + Number(o.total);
  });
  const monthlyRevenue: { month: string; revenue: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("ar-SA", { month: "short", year: "numeric" });
    monthlyRevenue.push({ month: label, revenue: Math.round((monthlyMap[key] ?? 0) * 100) / 100 });
  }

  res.json({
    total_parts:     partsRes.count ?? 0,
    total_customers: customersRes.count ?? 0,
    total_orders:    allOrders.length,
    total_revenue:   totalRevenue,
    month_revenue:   monthRevenue,
    low_stock_count: (inventoryRes.data ?? []).length,
    revenue_trend:   revenueTrend,
    top_parts:       topParts,
    top_customers:   topCustomers,
    monthly_revenue: monthlyRevenue,
  });
});

// GET /api/reports/vat?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/vat", requireAuth, async (req: AuthRequest, res: Response) => {
  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const from = (req.query.from as string) || defaultFrom;
  const to   = (req.query.to   as string) || now.toISOString().split("T")[0];

  const [salesRes, purchasesRes] = await Promise.all([
    supabaseAdmin
      .from("sales_orders")
      .select("total, subtotal, tax_amount, status, created_at")
      .gte("created_at", `${from}T00:00:00Z`)
      .lte("created_at", `${to}T23:59:59Z`)
      .neq("status", "cancelled"),
    supabaseAdmin
      .from("purchase_orders")
      .select("total, subtotal, tax_amount, status, created_at")
      .gte("created_at", `${from}T00:00:00Z`)
      .lte("created_at", `${to}T23:59:59Z`)
      .neq("status", "cancelled"),
  ]);

  const sales     = salesRes.data ?? [];
  const purchases = purchasesRes.data ?? [];

  const taxableSales    = sales.reduce((s, o) => s + Number(o.subtotal ?? 0), 0);
  const vatCollected    = sales.reduce((s, o) => s + Number(o.tax_amount ?? 0), 0);
  const totalSales      = sales.reduce((s, o) => s + Number(o.total ?? 0), 0);

  const taxablePurchases = purchases.reduce((s, o) => s + Number(o.subtotal ?? 0), 0);
  const vatPaid          = purchases.reduce((s, o) => s + Number(o.tax_amount ?? 0), 0);
  const totalPurchases   = purchases.reduce((s, o) => s + Number(o.total ?? 0), 0);

  const netVat = vatCollected - vatPaid;

  // Monthly breakdown
  const byMonth: Record<string, { sales: number; vat_collected: number; purchases: number; vat_paid: number }> = {};
  sales.forEach((o) => {
    const m = o.created_at.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { sales: 0, vat_collected: 0, purchases: 0, vat_paid: 0 };
    byMonth[m].sales         += Number(o.subtotal ?? 0);
    byMonth[m].vat_collected += Number(o.tax_amount ?? 0);
  });
  purchases.forEach((o) => {
    const m = o.created_at.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { sales: 0, vat_collected: 0, purchases: 0, vat_paid: 0 };
    byMonth[m].purchases += Number(o.subtotal ?? 0);
    byMonth[m].vat_paid  += Number(o.tax_amount ?? 0);
  });

  res.json({
    period: { from, to },
    summary: {
      taxable_sales:     Math.round(taxableSales     * 100) / 100,
      vat_collected:     Math.round(vatCollected     * 100) / 100,
      total_sales:       Math.round(totalSales       * 100) / 100,
      taxable_purchases: Math.round(taxablePurchases * 100) / 100,
      vat_paid:          Math.round(vatPaid          * 100) / 100,
      total_purchases:   Math.round(totalPurchases   * 100) / 100,
      net_vat:           Math.round(netVat           * 100) / 100,
      orders_count:      sales.length,
      purchases_count:   purchases.length,
    },
    by_month: byMonth,
  });
});

export default router;
