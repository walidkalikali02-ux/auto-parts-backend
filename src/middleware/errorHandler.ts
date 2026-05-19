import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error("[ERROR]", err);
  const status  = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? "خطأ داخلي في الخادم";
  res.status(status).json({ error: message });
}

export function notFound(req: Request, res: Response) {
  res.status(404).json({ error: `المسار غير موجود: ${req.method} ${req.path}` });
}
