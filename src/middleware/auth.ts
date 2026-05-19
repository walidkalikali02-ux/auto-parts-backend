import { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase.js";

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role?: string };
  token?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "مطلوب تسجيل الدخول" });
    return;
  }

  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: "جلسة غير صالحة" });
    return;
  }

  // Get profile for role
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  req.user  = { id: user.id, email: user.email!, role: profile?.role };
  req.token = token;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!roles.includes(req.user.role ?? "")) {
      res.status(403).json({ error: "لا تملك الصلاحية الكافية" });
      return;
    }
    next();
  };
}
