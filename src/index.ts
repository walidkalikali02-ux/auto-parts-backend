import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes          from "./routes/auth.js";
import partsRoutes         from "./routes/parts.js";
import inventoryRoutes     from "./routes/inventory.js";
import ordersRoutes        from "./routes/orders.js";
import quotesRoutes        from "./routes/quotes.js";
import customersRoutes     from "./routes/customers.js";
import suppliersRoutes     from "./routes/suppliers.js";
import compatibilityRoutes from "./routes/compatibility.js";
import vinRoutes           from "./routes/vin.js";
import reportsRoutes       from "./routes/reports.js";
import settingsRoutes      from "./routes/settings.js";
import paymentsRoutes      from "./routes/payments.js";
import notificationsRoutes from "./routes/notifications.js";

import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app  = express();
const PORT = parseInt(process.env.PORT ?? "4000");

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(","),
  credentials: true,
}));
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use("/api/auth/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "عدد كبير من محاولات الدخول، حاول بعد 15 دقيقة" },
}));
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: "تجاوزت الحد المسموح من الطلبات" },
}));

// ============================================================
// ROOT + HEALTH CHECK
// ============================================================
app.get("/", (_req, res) => {
  res.json({
    name:    "AutoParts ERP API",
    version: "1.0.0",
    status:  "ok",
    docs:    "/api",
    health:  "/health",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status:  "ok",
    service: "auto-parts-erp-backend",
    version: "1.0.0",
    time:    new Date().toISOString(),
  });
});

// API info
app.get("/api", (_req, res) => {
  res.json({
    name:    "AutoParts ERP API",
    version: "1.0.0",
    docs:    "https://github.com/walidkalikali02-ux/auto-parts-erp",
    endpoints: [
      "POST   /api/auth/login",
      "POST   /api/auth/logout",
      "GET    /api/auth/me",
      "POST   /api/auth/refresh",
      "GET    /api/parts",
      "POST   /api/parts",
      "GET    /api/parts/:id",
      "PUT    /api/parts/:id",
      "DELETE /api/parts/:id",
      "GET    /api/parts/:id/compatibility",
      "GET    /api/parts/:id/cross-refs",
      "GET    /api/parts/:id/substitutes",
      "GET    /api/inventory",
      "POST   /api/inventory/adjust",
      "GET    /api/inventory/movements",
      "GET    /api/inventory/low-stock",
      "GET    /api/inventory/warehouses",
      "GET    /api/orders/sales",
      "POST   /api/orders/sales",
      "GET    /api/orders/sales/:id",
      "PUT    /api/orders/sales/:id/status",
      "POST   /api/orders/returns",
      "GET    /api/orders/purchase",
      "POST   /api/orders/purchase",
      "PUT    /api/orders/purchase/:id/receive",
      "GET    /api/quotes",
      "POST   /api/quotes",
      "GET    /api/quotes/:id",
      "PUT    /api/quotes/:id/status",
      "POST   /api/quotes/:id/convert",
      "GET    /api/customers",
      "POST   /api/customers",
      "GET    /api/customers/:id",
      "PUT    /api/customers/:id",
      "GET    /api/customers/:id/vehicles",
      "POST   /api/customers/:id/vehicles",
      "GET    /api/suppliers",
      "POST   /api/suppliers",
      "GET    /api/compatibility?brand_id=&model_id=&year=",
      "GET    /api/compatibility/brands",
      "GET    /api/compatibility/models?brand_id=",
      "GET    /api/compatibility/categories",
      "GET    /api/vin/:vin",
      "GET    /api/reports/daily?date=",
      "GET    /api/reports/inventory",
      "GET    /api/reports/dashboard",
    ],
  });
});

// ============================================================
// ROUTES
// ============================================================
app.use("/api/auth",          authRoutes);
app.use("/api/parts",         partsRoutes);
app.use("/api/inventory",     inventoryRoutes);
app.use("/api/orders",        ordersRoutes);
app.use("/api/quotes",        quotesRoutes);
app.use("/api/customers",     customersRoutes);
app.use("/api/suppliers",     suppliersRoutes);
app.use("/api/compatibility", compatibilityRoutes);
app.use("/api/vin",           vinRoutes);
app.use("/api/reports",       reportsRoutes);
app.use("/api/settings",       settingsRoutes);
app.use("/api/payments",       paymentsRoutes);
app.use("/api/notifications",  notificationsRoutes);

// ============================================================
// ERROR HANDLING
// ============================================================
app.use(notFound);
app.use(errorHandler);

// Only start HTTP server in local dev — Vercel handles this in production
if (process.env.NODE_ENV !== "production" || process.env.FORCE_LISTEN === "true") {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     AutoParts ERP — Node.js Backend          ║
║     نظام ERP لقطع غيار السيارات              ║
╠══════════════════════════════════════════════╣
║  🚀  http://localhost:${PORT}                    ║
║  📋  http://localhost:${PORT}/api                ║
║  🏥  http://localhost:${PORT}/health              ║
╚══════════════════════════════════════════════╝
    `);
  });
}

export default app;
