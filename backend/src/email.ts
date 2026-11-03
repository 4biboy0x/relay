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

  const subject = purpose === "signup" ? "Verify your Relay account" : "Reset your Relay password";
  const html = `<p>Your Relay verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p><p>If you did not request this, you can safely ignore it.</p>`;
  try {
    await getTransporter().sendMail({
      from: { name: "Relay", address: config.EMAIL_USER },
      to: email,
      subject,
      html,
    });
  } catch {
    console.error("Gmail SMTP OTP delivery failed.");
    throw new EmailDeliveryError();
  }
};
