import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "./config";

let transporter: Transporter | null = null;

export class EmailDeliveryError extends Error {
  constructor() {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryError";
  }
}

const otpEmailContent = (
  code: string,
  purpose: "signup" | "reset",
): { subject: string; html: string; text: string } => {
  const isSignup = purpose === "signup";
  const subject = isSignup ? "Verify your Relay account" : "Reset your Relay password";
  const title = isSignup ? "Verify your email" : "Reset your password";
  const instruction = isSignup
    ? "Use this code to verify your email."
    : "Use this code to reset your password.";
  const fontUrl = `${config.CLIENT_ORIGIN}/assets/fonts/Piazzolla-Light.woff2`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      @font-face {
        font-family: "Piazzolla";
        src: url("${fontUrl}") format("woff2");
        font-style: normal;
        font-weight: 300;
      }
    </style>
  </head>
  <body style="margin:0;padding:32px 16px;background:#f4f4f5;color:#09090b;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;">
      <tr>
        <td style="padding:28px 32px 30px;">
          <div style="font-family:'Piazzolla',Georgia,serif;font-size:30px;font-weight:300;letter-spacing:-1.3px;line-height:1;color:#09090b;">Relay</div>
          <div style="height:1px;margin:22px 0;background:#e4e4e7;"></div>
          <h1 style="margin:0 0 10px;font-size:20px;font-weight:600;line-height:1.3;color:#09090b;">${title}</h1>
          <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#52525b;">${instruction}</p>
          <div style="display:inline-block;padding:12px 16px;border:1px solid #e4e4e7;border-radius:8px;background:#fafafa;font-size:28px;font-weight:600;letter-spacing:7px;line-height:1.2;color:#09090b;">${code}</div>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Expires in 10 minutes.</p>
          <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Didn't request this? Ignore this email.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  const text = `${title}\\n\\n${instruction}\\n\\n${code}\\n\\nExpires in 10 minutes.\\nDidn't request this? Ignore this email.`;
  return { subject, html, text };
};

const getTransporter = (): Transporter => {
  if (!transporter) {
    const password = config.EMAIL_PASS?.replace(/\s/g, "");
    if (!config.EMAIL_USER || !password) {
      throw new EmailDeliveryError();
    }

    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: config.EMAIL_USER,
        pass: password,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
};

export const sendOtpEmail = async (
  email: string,
  code: string,
  purpose: "signup" | "reset",
): Promise<void> => {
  if (!config.EMAIL_USER || !config.EMAIL_PASS) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[otp-dev] ${purpose} code for ${email}: ${code}`);
      return;
    }
    console.error("Gmail SMTP OTP delivery is not configured.");
    throw new EmailDeliveryError();
  }

  const content = otpEmailContent(code, purpose);
  try {
    await getTransporter().sendMail({
      from: { name: "Relay", address: config.EMAIL_USER },
      to: email,
      ...content,
    });
  } catch {
    console.error("Gmail SMTP OTP delivery failed.");
    throw new EmailDeliveryError();
  }
};
