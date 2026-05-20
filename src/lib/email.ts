import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface EmailPayload {
  to: string | string[];
  subject: string;
  html: string;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  if (!resend) {
    console.log("[email] RESEND_API_KEY not set — skipping:", payload.subject);
    return false;
  }
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "AutoParts ERP <noreply@autoparts.sa>",
      to: Array.isArray(payload.to) ? payload.to : [payload.to],
      subject: payload.subject,
      html: payload.html,
    });
    return true;
  } catch (err) {
    console.error("[email] send failed:", err);
    return false;
  }
}

// ─── Email Templates ──────────────────────────────────────────────────────

export function orderConfirmedHtml(order: {
  order_number: string;
  customer_name: string;
  total: number;
  items: { name: string; qty: number; price: number }[];
  tenant_name: string;
}) {
  const rows = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;font-family:sans-serif;font-size:13px">${i.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;text-align:center;font-family:monospace">${i.qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;text-align:right;font-family:monospace">${i.price.toFixed(2)} ر.س</td>
      </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="margin:0;padding:0;background:#f9f7f0;font-family:Cairo,Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#B5892A;padding:28px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">${order.tenant_name}</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px">تأكيد الطلب</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:15px;color:#1a1705;margin:0 0 4px">مرحباً ${order.customer_name}،</p>
      <p style="font-size:13px;color:#666;margin:0 0 24px">تم تأكيد طلبك رقم <strong style="color:#B5892A">#${order.order_number}</strong> بنجاح.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="background:#f9f7f0">
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#999;font-weight:600">القطعة</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;color:#999;font-weight:600">الكمية</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#999;font-weight:600">السعر</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="background:#f9f7f0;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:14px;color:#666">الإجمالي شامل الضريبة</span>
        <span style="font-size:18px;font-weight:700;color:#B5892A;font-family:monospace">${order.total.toFixed(2)} ر.س</span>
      </div>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #f0ece0;text-align:center">
      <p style="margin:0;font-size:11px;color:#aaa">${order.tenant_name} — نظام إدارة قطع الغيار</p>
    </div>
  </div>
</body>
</html>`;
}

export function lowStockAlertHtml(items: { name: string; part_number: string; qty: number; reorder_point: number }[], tenantName: string) {
  const rows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;font-family:sans-serif;font-size:13px">${i.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;font-family:monospace;font-size:12px;color:#999">${i.part_number}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;text-align:center;font-family:monospace;color:${i.qty === 0 ? "#DC2626" : "#EA580C"};font-weight:700">${i.qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece0;text-align:center;font-family:monospace;color:#999">${i.reorder_point}</td>
      </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="margin:0;padding:0;background:#f9f7f0;font-family:Cairo,Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#DC2626;padding:28px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">تنبيه: مخزون منخفض</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px">${tenantName}</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#1a1705;margin:0 0 20px">
        الأصناف التالية وصلت إلى حد إعادة الطلب أو نفدت من المخزون:
      </p>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f9f7f0">
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#999;font-weight:600">القطعة</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#999;font-weight:600">الرقم</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;color:#999;font-weight:600">الكمية</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;color:#999;font-weight:600">حد الإعادة</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

export function inviteHtml(invite: { inviteUrl: string; role: string; tenantName: string }) {
  const roleAr: Record<string, string> = { admin: "مدير", staff: "موظف", accountant: "محاسب" };
  return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="margin:0;padding:0;background:#f9f7f0;font-family:Cairo,Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#B5892A;padding:28px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">${invite.tenantName}</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px">دعوة للانضمام</p>
    </div>
    <div style="padding:32px">
      <p style="font-size:15px;color:#1a1705;margin:0 0 8px">تمت دعوتك للانضمام إلى <strong>${invite.tenantName}</strong></p>
      <p style="font-size:13px;color:#666;margin:0 0 28px">
        دورك في النظام: <strong style="color:#B5892A">${roleAr[invite.role] ?? invite.role}</strong>
      </p>
      <a href="${invite.inviteUrl}"
        style="display:inline-block;background:#B5892A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:600">
        قبول الدعوة وإنشاء حساب
      </a>
      <p style="font-size:11px;color:#aaa;margin-top:24px">صالحة لمدة 7 أيام. إذا لم تطلب هذه الدعوة، يمكنك تجاهل هذا البريد.</p>
    </div>
  </div>
</body>
</html>`;
}
